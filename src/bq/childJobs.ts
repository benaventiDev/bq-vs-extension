import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import treeKill from 'tree-kill';
import type { SchemaField } from './dryRun';

/**
 * Per-child-statement metadata fetched after a multi-statement script
 * completes. Built by listing the parent job's children, then for each
 * SELECT-typed child fetching its destination-table schema (which is
 * where bq actually persists column metadata — neither the job itself
 * nor the bq query output JSON carries per-statement schema).
 *
 * Sorted in source order (by stack-frame start line/column), which is
 * the same order bq emits results in its top-level output array.
 */
export interface ChildJobInfo {
  /** Statement text, exactly as parsed by BigQuery. */
  statementText: string;
  /** BigQuery's classification: SELECT, INSERT, UPDATE, DELETE, MERGE,
   *  CREATE_TABLE, DROP_TABLE, ALTER_TABLE, MERGE, SCRIPT, etc. */
  statementType: string;
  /** Schema with column names in SELECT order. Present for SELECT-typed
   *  children only; null for DDL/DML/script-control statements. */
  schema: SchemaField[] | null;
  /** DML row count when available (INSERT/UPDATE/DELETE/MERGE), else null. */
  numDmlAffectedRows: number | null;
  /** Per-statement execution time in ms (endTime - startTime from the job
   *  list entry). Null when bq didn't return those fields. */
  executionMs: number | null;
  /** BigQuery's script classification: 'STATEMENT' for a top-level statement
   *  that emits exactly one element into bq's output array (in source order),
   *  or 'EXPRESSION' for a subquery inside SET / an IF condition (which runs as
   *  a child job but produces NO output element). null when bq didn't report
   *  it (older bq). Drives output-element <-> child alignment (see
   *  filterOutputProducingChildren). */
  evaluationKind: string | null;
}

const MISSING_BQ_MESSAGE = 'bq CLI not found on PATH.';

export interface ChildJobsHandle {
  promise: Promise<{ ok: true; children: ChildJobInfo[] } | { ok: false; error: string }>;
  cancel: () => void;
}

/**
 * Enumerate child jobs of a parent script job and fetch per-SELECT schema
 * in parallel. Returns the children sorted by source order. Cancellation
 * tree-kills all in-flight bq subprocesses (same Windows-safe pattern as
 * the main query path).
 *
 * Latency note: one `bq ls` round-trip + N parallel `bq show --schema`
 * round-trips per SELECT child. Metadata-only; no billable work.
 */
export function fetchChildJobs(parentJobId: string): ChildJobsHandle {
  const inFlight = new Set<number>();
  let cancelled = false;

  const promise = (async () => {
    try {
      const listResult = await spawnBq(
        ['ls', '--jobs', `--parent_job_id=${parentJobId}`, '--format=json', '-n', '1000'],
        inFlight,
        () => cancelled,
      );
      if (cancelled) return { ok: false as const, error: 'Cancelled' };
      if (!listResult.ok) return listResult;

      const children = parseChildList(listResult.stdout);
      // Schema fetches: parallelize across SELECT children. Non-SELECTs
      // (DDL / DML / script control) don't have a meaningful column schema.
      const enriched = await Promise.all(
        children.map(async (c) => {
          if (c._destinationTable && c.statementType === 'SELECT') {
            const schemaResult = await spawnBq(
              ['show', '--schema', '--format=json', c._destinationTable],
              inFlight,
              () => cancelled,
            );
            if (cancelled) return null;
            if (schemaResult.ok) {
              c.schema = parseSchemaArray(schemaResult.stdout);
            }
          }
          return c;
        }),
      );
      if (cancelled) return { ok: false as const, error: 'Cancelled' };

      const final: ChildJobInfo[] = enriched
        .filter((c): c is ParsedChild => c !== null)
        .map(({ _destinationTable, _sortKey, ...rest }) => {
          void _destinationTable;
          void _sortKey;
          return rest;
        });

      return { ok: true as const, children: final };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      for (const pid of inFlight) {
        treeKill(pid, 'SIGTERM', () => {});
      }
      inFlight.clear();
    },
  };
}

interface ParsedChild extends ChildJobInfo {
  _destinationTable: string | null;
  _sortKey: number;
}

interface SpawnOk { ok: true; stdout: string }
interface SpawnErr { ok: false; error: string }

function spawnBq(
  args: string[],
  inFlight: Set<number>,
  isCancelled: () => boolean,
): Promise<SpawnOk | SpawnErr> {
  return new Promise((resolve) => {
    if (isCancelled()) {
      resolve({ ok: false, error: 'Cancelled' });
      return;
    }
    const isWindows = process.platform === 'win32';
    // Force bq's Python to emit UTF-8 (see runQuery.ts for the full rationale).
    // PYTHONUTF8=1 (PEP 540) is the primary fix; PYTHONIOENCODING is the
    // backup for older Python versions.
    const child = spawn('bq', args, {
      shell: isWindows,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    if (typeof child.pid === 'number') inFlight.add(child.pid);

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (r: SpawnOk | SpawnErr) => {
      if (settled) return;
      settled = true;
      if (typeof child.pid === 'number') inFlight.delete(child.pid);
      resolve(r);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        settle({ ok: false, error: MISSING_BQ_MESSAGE });
      } else {
        settle({ ok: false, error: err.message });
      }
    });
    child.on('close', (code) => {
      if (code === 0) {
        settle({ ok: true, stdout });
      } else {
        settle({ ok: false, error: (stderr || stdout || `bq exited with code ${code}`).trim() });
      }
    });
    child.stdin.on('error', () => { /* ignored — error event fires too */ });
    try {
      child.stdin.end();
    } catch { /* ignored */ }
  });
}

interface BqJobListEntry {
  jobReference?: { jobId?: string };
  configuration?: {
    query?: {
      destinationTable?: { projectId?: string; datasetId?: string; tableId?: string };
    };
  };
  statistics?: {
    // BigQuery returns these as ms-since-epoch *strings* (1e3 magnitudes the
    // JSON-spec int range can't always carry exactly). Parse to Number; the
    // difference is well within safe-integer range for any plausible query.
    startTime?: string;
    endTime?: string;
    query?: {
      statementType?: string;
      numDmlAffectedRows?: string;
    };
    scriptStatistics?: {
      evaluationKind?: string;
      stackFrames?: Array<{
        startLine?: number;
        startColumn?: number;
        text?: string;
      }>;
    };
  };
}

function parseChildList(stdout: string): ParsedChild[] {
  let arr: unknown;
  try {
    arr = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const parsed: ParsedChild[] = [];
  for (const raw of arr as BqJobListEntry[]) {
    const stmtType = raw.statistics?.query?.statementType ?? 'UNKNOWN';
    const frame = raw.statistics?.scriptStatistics?.stackFrames?.[0];
    const stmtText = frame?.text ?? '';
    // Sort key: line * 1e6 + column (column-precise within a line). Statements
    // without stackFrame info (rare) sort to the end via a large sentinel.
    const sortKey =
      frame && typeof frame.startLine === 'number'
        ? frame.startLine * 1_000_000 + (frame.startColumn ?? 0)
        : Number.MAX_SAFE_INTEGER;

    const dt = raw.configuration?.query?.destinationTable;
    const destTableRef =
      dt && dt.projectId && dt.datasetId && dt.tableId
        ? `${dt.projectId}:${dt.datasetId}.${dt.tableId}`
        : null;

    const evalKind = raw.statistics?.scriptStatistics?.evaluationKind ?? null;

    const dmlStr = raw.statistics?.query?.numDmlAffectedRows;
    const dmlNum = dmlStr ? parseInt(dmlStr, 10) : NaN;

    const startStr = raw.statistics?.startTime;
    const endStr = raw.statistics?.endTime;
    const startMs = startStr ? parseInt(startStr, 10) : NaN;
    const endMs = endStr ? parseInt(endStr, 10) : NaN;
    const execMs =
      Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
        ? endMs - startMs
        : null;

    parsed.push({
      statementText: stmtText,
      statementType: stmtType,
      schema: null,
      numDmlAffectedRows: Number.isFinite(dmlNum) ? dmlNum : null,
      executionMs: execMs,
      evaluationKind: evalKind,
      _destinationTable: destTableRef,
      _sortKey: sortKey,
    });
  }
  parsed.sort((a, b) => a._sortKey - b._sortKey);
  return parsed;
}

function parseSchemaArray(stdout: string): SchemaField[] | null {
  try {
    const arr = JSON.parse(stdout) as unknown;
    if (Array.isArray(arr)) return arr as SchemaField[];
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Generate a per-run job_id we can later pass to `bq ls --parent_job_id`
 * to find child statements. Format: `bq_vs_ext_<32-hex-chars>`.
 *
 * Uses `crypto.randomUUID()` (~2^122 of entropy) with hyphens stripped,
 * instead of the original `Date.now()` + `Math.random()` suffix. The old
 * format could collide when two queries fired within the same millisecond
 * (bq then rejected the second with "Already Exists: Job ..."); randomUUID
 * makes that practically impossible.
 *
 * The resulting ID is lowercase hex + underscores only — well within
 * BigQuery's job-ID rules (alphanumeric + underscore + hyphen, max 1024
 * chars). The `bq_vs_ext_` prefix is preserved so our jobs stay
 * identifiable in `bq ls` and debug logs.
 */
export function generateJobId(): string {
  return `bq_vs_ext_${randomUUID().replace(/-/g, '')}`;
}
