import * as snowflake from 'snowflake-sdk';
import { createHash } from 'crypto';
import {
  loadSnowflakeConfig,
  pickConnectionName,
  toSdkOptions,
  type ConfigEnv,
  realConfigEnv,
} from './config';
import { formatTime, type SfColumnMeta } from './convert';

// One Snowflake session per configured connection, opened lazily on the
// first run and reused afterwards — so `USE DATABASE`, session variables and
// temp tables carry over between runs, like a Snowsight worksheet.

// Same ceiling as the BigQuery path (see bq/runQuery.ts): beyond this the
// grid can't render the result anyway, so stop streaming and say so.
const MAX_RESULT_MB = 256;
const MAX_RESULT_BYTES = MAX_RESULT_MB * 1024 * 1024;
export const RESULT_TOO_LARGE_MESSAGE =
  `Result too large to display. The query produced more than ${MAX_RESULT_MB} MB of output, ` +
  `so it was stopped to keep VS Code responsive. Add a LIMIT clause (or a narrower WHERE / ` +
  `fewer columns) and run again.`;
export const CANCELLED_MESSAGE = 'Query cancelled.';

type SdkConnection = snowflake.Connection;
type SdkStatement = snowflake.RowStatement;

let configured = false;

function configureSdkOnce(): void {
  if (configured) return;
  configured = true;
  // The driver logs to a file in the process cwd by default; the extension
  // host's cwd is arbitrary, so keep it quiet.
  try {
    snowflake.configure({ logLevel: 'OFF', additionalLogToConsole: false } as snowflake.ConfigureOptions);
  } catch {
    // older/newer SDKs may reject an option — harmless
  }
  patchTimeFormatting();
}

/**
 * The SDK renders TIME values with the session's TIME_OUTPUT_FORMAT (default
 * HH24:MI:SS, no fraction) and offers no raw accessor. Changing the session
 * parameter would alter the user's own TO_VARCHAR(time) results, so instead
 * make the SDK's SfTime print every fractional digit the column scale holds.
 */
function patchTimeFormatting(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const SfTimestamp = require('snowflake-sdk/dist/lib/connection/result/sf_timestamp');
    const proto = SfTimestamp?.prototype;
    if (!proto || typeof proto.toSfTime !== 'function' || proto.__bqxPatched) return;
    const original = proto.toSfTime;
    proto.toSfTime = function (this: { epochSeconds: number; nanoSeconds: number; scale: number }) {
      const t = original.call(this);
      const text = formatTime(this.epochSeconds, this.nanoSeconds, this.scale);
      t.toJSON = () => text;
      return t;
    };
    proto.__bqxPatched = true;
  } catch {
    // SDK layout changed: TIME falls back to the session format.
  }
}

interface CachedConnection {
  key: string;
  name: string;
  conn: Promise<SdkConnection>;
}

const cache = new Map<string, CachedConnection>();

export interface ResolvedConnection {
  name: string;
  options: Record<string, unknown>;
}

export function resolveConnection(
  preferredName: string | undefined,
  ce: ConfigEnv = realConfigEnv(),
): ResolvedConnection | { error: string } {
  const cfg = loadSnowflakeConfig(ce);
  const picked = pickConnectionName(cfg, preferredName);
  if ('error' in picked) {
    const extra = cfg.warnings.length ? ` (${cfg.warnings.join('; ')})` : '';
    return { error: picked.error + extra };
  }
  let options: Record<string, unknown>;
  try {
    options = toSdkOptions(cfg.connections[picked.name], ce);
  } catch (err) {
    return { error: `Snowflake connection "${picked.name}": ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!options.account) {
    return { error: `Snowflake connection "${picked.name}" has no "account" set.` };
  }
  return { name: picked.name, options };
}

function optionsKey(options: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(options)).digest('hex');
}

function connect(options: Record<string, unknown>): Promise<SdkConnection> {
  configureSdkOnce();
  const conn = snowflake.createConnection({
    // Keep the session alive across long idle periods between runs.
    clientSessionKeepAlive: true,
    ...options,
  } as snowflake.ConnectionOptions);
  return new Promise<SdkConnection>((resolve, reject) => {
    // connectAsync supports every authenticator, including the browser-based
    // ones (EXTERNALBROWSER, Okta, OAuth authorization code).
    conn
      .connectAsync((err) => {
        if (err) reject(err);
        else resolve(conn);
      })
      .catch(reject);
  });
}

/**
 * Get (or open) the session for a resolved connection. The cache is keyed by
 * the full option set, so editing connections.toml (new password, role,
 * warehouse, ...) transparently opens a fresh session on the next run.
 */
export function getConnection(resolved: ResolvedConnection): Promise<SdkConnection> {
  const key = optionsKey(resolved.options);
  const hit = cache.get(resolved.name);
  if (hit && hit.key === key) return hit.conn;
  if (hit) void hit.conn.then((c) => destroyQuietly(c)).catch(() => {});
  const conn = connect(resolved.options);
  const entry: CachedConnection = { key, name: resolved.name, conn };
  cache.set(resolved.name, entry);
  conn.catch(() => {
    // Don't keep a failed login around: the next run retries.
    if (cache.get(resolved.name) === entry) cache.delete(resolved.name);
  });
  return conn;
}

/** Forget a session (e.g. it was terminated server-side). */
export function dropConnection(name: string): void {
  const hit = cache.get(name);
  if (!hit) return;
  cache.delete(name);
  void hit.conn.then((c) => destroyQuietly(c)).catch(() => {});
}

function destroyQuietly(conn: SdkConnection): void {
  try {
    conn.destroy(() => {});
  } catch {
    // ignore
  }
}

export function disposeAllConnections(): void {
  for (const name of [...cache.keys()]) dropConnection(name);
}

/** True when an error means the session is gone and a reconnect may help. */
export function isConnectionLost(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? '');
  return (
    code === '407002' || code === '405503' || code === '390114' || code === '390112' ||
    /terminated connection|session (no longer exists|does not exist)|authentication token has expired|not connected/i.test(msg)
  );
}

export type StatementResult =
  | {
      ok: true;
      columns: SfColumnMeta[];
      rows: unknown[][];
      numUpdatedRows: number | null;
      queryId: string | undefined;
      elapsedMs: number;
    }
  | { ok: false; error: string; cancelled?: boolean; tooLarge?: boolean; connectionLost?: boolean };

export interface StatementHandle {
  promise: Promise<StatementResult>;
  cancel: () => void;
}

function approxSize(v: unknown): number {
  if (v === null || v === undefined) return 4;
  if (typeof v === 'string') return v.length + 2;
  if (typeof v === 'number' || typeof v === 'boolean') return 8;
  if (v instanceof Uint8Array) return v.length * 1.4;
  return 64;
}

/** Execute one statement on a session, streaming rows under the size cap. */
export function executeStatement(conn: SdkConnection, sqlText: string, maxBytes = MAX_RESULT_BYTES): StatementHandle {
  let stmt: SdkStatement | undefined;
  let settled = false;
  let resolveFn: (r: StatementResult) => void = () => {};
  const promise = new Promise<StatementResult>((resolve) => {
    resolveFn = resolve;
  });
  const settle = (r: StatementResult): void => {
    if (settled) return;
    settled = true;
    resolveFn(r);
  };
  const started = performance.now();

  try {
    stmt = conn.execute({
      sqlText,
      streamResult: true,
      rowMode: 'array',
      fetchAsString: ['Number', 'JSON'],
      complete: (err, s) => {
        if (settled) return;
        if (err) {
          settle({ ok: false, error: err.message, connectionLost: isConnectionLost(err) });
          return;
        }
        const columns: SfColumnMeta[] = (s.getColumns() ?? []).map((c) => ({
          name: c.getName(),
          type: String(c.getType()).toLowerCase(),
          scale: typeof c.getScale() === 'number' ? (c.getScale() as number) : null,
        }));
        const rows: unknown[][] = [];
        let bytes = 0;
        const stream = s.streamRows();
        stream.on('data', (row: unknown) => {
          if (settled) return;
          const arr = row as unknown[];
          rows.push(arr);
          for (const v of arr) bytes += approxSize(v);
          if (bytes > maxBytes) {
            settle({ ok: false, error: RESULT_TOO_LARGE_MESSAGE, tooLarge: true });
            try { stream.destroy(); } catch { /* ignore */ }
            try { s.cancel(() => {}); } catch { /* ignore */ }
          }
        });
        stream.on('error', (e: Error) => settle({ ok: false, error: e.message, connectionLost: isConnectionLost(e) }));
        stream.on('end', () => {
          const n = s.getNumUpdatedRows();
          settle({
            ok: true,
            columns,
            rows,
            numUpdatedRows: typeof n === 'number' && n >= 0 ? n : null,
            queryId: s.getQueryId?.() ?? s.getStatementId?.(),
            elapsedMs: Math.round(performance.now() - started),
          });
        });
      },
    } as snowflake.StatementOption) as SdkStatement;
  } catch (err) {
    settle({ ok: false, error: err instanceof Error ? err.message : String(err), connectionLost: isConnectionLost(err) });
  }

  return {
    promise,
    cancel: () => {
      if (settled) return;
      settle({ ok: false, error: CANCELLED_MESSAGE, cancelled: true });
      try {
        stmt?.cancel(() => {});
      } catch {
        // ignore
      }
    },
  };
}
