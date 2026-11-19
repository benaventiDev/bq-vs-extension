import type { StatementOutcome, TabResult, TimingInfo } from '../panel/types';
import {
  CANCELLED_MESSAGE,
  dropConnection,
  executeStatement,
  getConnection,
  resolveConnection,
  type ResolvedConnection,
  type StatementResult,
} from './client';
import { convertResult } from './convert';
import { leadingKeyword, splitSnowflakeSql } from './split';

export interface SnowflakeRunHandle {
  promise: Promise<TabResult>;
  cancel: () => void;
}

const DML_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);
// Statements whose single "status" column is real data, not a status banner.
const RESULT_KEYWORDS = new Set(['SELECT', 'WITH', 'SHOW', 'DESC', 'DESCRIBE', 'CALL', 'LIST', 'LS', 'VALUES', 'TABLE', 'EXPLAIN']);

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

/** Turn one successful statement into the grid's per-statement outcome. */
export function toOutcome(sql: string, r: Extract<StatementResult, { ok: true }>): StatementOutcome {
  const kw = leadingKeyword(sql);
  const executionMs = r.elapsedMs;
  if (DML_KEYWORDS.has(kw)) {
    let n = r.numUpdatedRows;
    if (n === null) {
      // MERGE / multi-table INSERT report one count column per action.
      n = 0;
      for (const v of r.rows[0] ?? []) {
        const num = Number(v);
        if (Number.isFinite(num)) n += num;
      }
    }
    return { kind: 'dml', rowsAffected: n, message: `${plural(n, 'row')} affected`, executionMs };
  }
  const isStatusOnly =
    r.columns.length === 1 && r.columns[0].name.toLowerCase() === 'status' && r.rows.length <= 1;
  if (r.columns.length === 0 || (isStatusOnly && !RESULT_KEYWORDS.has(kw))) {
    const status = r.rows[0]?.[0];
    return {
      kind: 'ddl',
      message: typeof status === 'string' && status.trim() ? status.trim() : 'Statement executed successfully.',
      executionMs,
    };
  }
  const parsed = convertResult(r.columns, r.rows);
  return { kind: 'select', columns: parsed.columns, rows: parsed.rows, executionMs };
}

/**
 * Run a selection / file against Snowflake. Scripts run statement by
 * statement on the shared session and stop at the first error, like a
 * BigQuery script.
 */
export function runSnowflake(
  sqlText: string,
  preferredConnection: string | undefined,
  opts: { maxBytes?: number } = {},
): SnowflakeRunHandle {
  let cancelled = false;
  let cancelCurrent: () => void = () => {};

  const promise = (async (): Promise<TabResult> => {
    const tStart = performance.now();
    const resolved = resolveConnection(preferredConnection);
    if ('error' in resolved) return { kind: 'error', message: resolved.error };

    const pieces = splitSnowflakeSql(sqlText).map((p) => p.sql);
    if (pieces.length === 0) return { kind: 'error', message: 'Nothing to run: the selection has no SQL statements.' };

    const connectOnce = async (r: ResolvedConnection) => {
      try {
        return { conn: await getConnection(r) } as const;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Could not connect to Snowflake (connection "${r.name}"): ${msg}` } as const;
      }
    };

    let session = await connectOnce(resolved);
    const connectMs = Math.round(performance.now() - tStart);
    if ('error' in session) return { kind: 'error', message: session.error ?? 'Could not connect to Snowflake.' };
    if (cancelled) return { kind: 'error', message: CANCELLED_MESSAGE };

    const outcomes: StatementOutcome[] = [];
    let execMs = 0;
    let parseMs = 0;

    for (const sql of pieces) {
      let handle = executeStatement(session.conn, sql, opts.maxBytes);
      cancelCurrent = handle.cancel;
      let result = await handle.promise;

      // Session expired / was killed between runs: reconnect once and retry.
      if (!result.ok && result.connectionLost && !cancelled) {
        dropConnection(resolved.name);
        const again = await connectOnce(resolved);
        if ('error' in again) {
          outcomes.push({ kind: 'error', message: again.error ?? result.error });
          break;
        }
        session = again;
        handle = executeStatement(session.conn, sql, opts.maxBytes);
        cancelCurrent = handle.cancel;
        result = await handle.promise;
      }

      if (cancelled || (!result.ok && result.cancelled)) {
        outcomes.push({ kind: 'cancelled' });
        break;
      }
      if (!result.ok) {
        outcomes.push({ kind: 'error', message: result.error });
        break;
      }
      execMs += result.elapsedMs;
      const tParse = performance.now();
      outcomes.push(toOutcome(sql, result));
      parseMs += performance.now() - tParse;
    }
    cancelCurrent = () => {};

    const timing: TimingInfo = {
      totalMs: Math.round(performance.now() - tStart),
      dryMs: connectMs,
      realMs: execMs,
      parseMs: Math.round(parseMs),
      engine: 'snowflake',
    };
    return buildTabResult(pieces, outcomes, timing);
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      cancelCurrent();
    },
  };
}

export function buildTabResult(pieces: string[], outcomes: StatementOutcome[], timing: TimingInfo): TabResult {
  if (pieces.length === 1 && outcomes.length === 1) {
    const only = outcomes[0];
    if (only.kind === 'select') return { kind: 'ok', columns: only.columns, rows: only.rows, timing };
    if (only.kind === 'error') return { kind: 'error', message: only.message };
    if (only.kind === 'cancelled') return { kind: 'error', message: CANCELLED_MESSAGE };
  }
  // Cancelled before anything finished: same as the BigQuery path.
  if (outcomes.length === 1 && outcomes[0].kind === 'cancelled') {
    return { kind: 'error', message: CANCELLED_MESSAGE };
  }
  const sqlPreviews = outcomes.map((_, i) => pieces[i] ?? null);
  return { kind: 'multi', statements: outcomes, sqlPreviews, timing };
}
