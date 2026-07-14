import { spawn } from 'child_process';
import treeKill from 'tree-kill';
import {
  BIGQUERY_API_BASE,
  CredentialError,
  FallbackError,
  bqAccessContext,
} from './bqClient';

export interface SchemaField {
  name: string;
  type: string;
  mode?: string;
  fields?: SchemaField[];
}

export type DryRunResult =
  | { ok: true; schema: SchemaField[] }
  | { ok: false; error: string };

export interface DryRunHandle {
  promise: Promise<DryRunResult>;
  cancel: () => void;
}

interface DryRunJobResponse {
  statistics?: { query?: { schema?: { fields?: SchemaField[] } } };
  error?: { message?: string };
}

const MISSING_BQ_MESSAGE = 'bq CLI not found on PATH. See README.md for prerequisites.';
const CANCELLED_MESSAGE = 'Query cancelled.';

const NOT_FOUND_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /command not found/i,
  /No such file or directory/i,
];

function extractErrorFromStdout(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'error' in parsed &&
        typeof (parsed as { error: unknown }).error === 'object'
      ) {
        const err = (parsed as { error: { message?: unknown } }).error;
        if (err && typeof err.message === 'string' && err.message.trim()) {
          return err.message;
        }
      }
    } catch {
      // fall through
    }
  }
  return trimmed;
}

function extractSchema(stdout: string): SchemaField[] | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      statistics?: {
        query?: { schema?: { fields?: SchemaField[] } };
      };
    };
    const fields = parsed?.statistics?.query?.schema?.fields;
    if (Array.isArray(fields)) return fields;
    return null;
  } catch {
    return null;
  }
}

/**
 * Dry-run the query via the BigQuery REST API using cached ADC credentials —
 * no `bq` CLI process, so it returns in ~250ms once the auth client is warm
 * instead of the CLI's ~10s. Returns the same schema shape as the CLI path
 * (`statistics.query.schema.fields`), so the rest of the pipeline is
 * unaffected. Throws {@link CredentialError} / {@link FallbackError} when the
 * caller should fall back to the CLI.
 */
function dryRunViaRest(sql: string): DryRunHandle {
  const controller = new AbortController();
  let aborted = false;
  const promise = (async (): Promise<DryRunResult> => {
    const { token, projectId } = await bqAccessContext();

    let resp;
    try {
      resp = await fetch(
        `${BIGQUERY_API_BASE}/projects/${encodeURIComponent(projectId)}/jobs`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            configuration: {
              dryRun: true,
              query: { query: sql, useLegacySql: false },
            },
          }),
          signal: controller.signal,
        },
      );
    } catch {
      if (aborted) return { ok: false, error: CANCELLED_MESSAGE };
      // Network / transport error — let the CLI try.
      throw new FallbackError();
    }

    // Auth rejections fall back to the CLI (the user may only have CLI auth).
    if (resp.status === 401 || resp.status === 403) {
      throw new CredentialError('BigQuery API rejected the credentials.');
    }

    const json = (await resp.json().catch(() => null)) as DryRunJobResponse | null;

    if (!resp.ok) {
      // A genuine query-validation error (bad SQL, missing table) carries a
      // message — surface it as-is. Anything else falls back to the CLI.
      const msg = json?.error?.message;
      if (typeof msg === 'string' && msg.trim()) {
        return { ok: false, error: msg };
      }
      throw new FallbackError();
    }

    const fields = json?.statistics?.query?.schema?.fields;
    return { ok: true, schema: Array.isArray(fields) ? fields : [] };
  })();
  return {
    promise,
    cancel: () => {
      aborted = true;
      controller.abort();
    },
  };
}

/**
 * Dry-run entry point. Tries the fast REST path first and transparently falls
 * back to the `bq` CLI when ADC isn't available or a transport error occurs,
 * so behaviour is unchanged for users who only ran `gcloud auth login`.
 */
export function dryRunQuery(sql: string): DryRunHandle {
  let cancelCurrent: () => void = () => {};
  let cancelled = false;
  const promise = (async (): Promise<DryRunResult> => {
    const rest = dryRunViaRest(sql);
    cancelCurrent = rest.cancel;
    try {
      return await rest.promise;
    } catch (err) {
      if (cancelled) return { ok: false, error: CANCELLED_MESSAGE };
      if (err instanceof CredentialError || err instanceof FallbackError) {
        const cli = dryRunViaCli(sql);
        cancelCurrent = cli.cancel;
        if (cancelled) {
          cli.cancel();
          return { ok: false, error: CANCELLED_MESSAGE };
        }
        return await cli.promise;
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  })();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      cancelCurrent();
    },
  };
}

function dryRunViaCli(sql: string): DryRunHandle {
  let cancelFn: () => void = () => {};
  const promise = new Promise<DryRunResult>((resolve) => {
    const isWindows = process.platform === 'win32';
    const child = spawn(
      'bq',
      [
        'query',
        '--quiet',
        '--use_legacy_sql=false',
        '--dry_run',
        '--format=prettyjson',
      ],
      // Force bq's Python to emit UTF-8 (see runQuery.ts for the full rationale).
      // PYTHONUTF8=1 (PEP 540) is the primary fix; PYTHONIOENCODING is the
      // backup for older Python versions.
      {
        shell: isWindows,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelled = false;

    const settle = (result: DryRunResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    cancelFn = () => {
      if (settled || cancelled) return;
      cancelled = true;
      if (typeof child.pid === 'number') {
        treeKill(child.pid, 'SIGTERM', () => {});
      } else {
        try { child.kill('SIGTERM'); } catch { /* ignored */ }
      }
      settle({ ok: false, error: CANCELLED_MESSAGE });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (cancelled) return;
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (cancelled) return;
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (cancelled) return;
      if (err.code === 'ENOENT') {
        settle({ ok: false, error: MISSING_BQ_MESSAGE });
      } else {
        settle({ ok: false, error: err.message });
      }
    });

    child.on('close', (code) => {
      if (cancelled) return;
      const combined = `${stderr}\n${stdout}`.trim();
      if (NOT_FOUND_PATTERNS.some((p) => p.test(combined))) {
        settle({ ok: false, error: MISSING_BQ_MESSAGE });
        return;
      }
      if (code === 0) {
        const schema = extractSchema(stdout);
        if (!schema) {
          // Dry-run succeeded but schema couldn't be extracted — fall back to
          // value-based inference by handing the caller an empty schema array.
          // (Caller already treats `[]` as "no schema, infer from values".)
          settle({ ok: true, schema: [] });
          return;
        }
        settle({ ok: true, schema });
        return;
      }
      const message =
        stderr.trim() ||
        extractErrorFromStdout(stdout) ||
        `bq dry-run exited with code ${code}`;
      settle({ ok: false, error: message });
    });

    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (cancelled) return;
      if (err.code === 'ENOENT' || err.code === 'EPIPE') {
        settle({ ok: false, error: MISSING_BQ_MESSAGE });
      }
    });

    try {
      child.stdin.write(sql);
      child.stdin.end();
    } catch {
      // 'error' handler above will fire
    }
  });
  return { promise, cancel: cancelFn };
}
