import { spawn } from 'child_process';
import treeKill from 'tree-kill';

export type RunQueryResult =
  | { ok: true; jsonText: string }
  // `partialJsonText` is whatever stdout had been streamed by the time the
  // process was killed. bq writes multi-statement output incrementally as an
  // array literal (element-per-line with leading commas), so a kill
  // mid-script usually leaves us with a buffer of completed elements that
  // can be salvaged by the caller — see commands/runSelection.ts. May be
  // empty if no output had been flushed.
  //
  // `tooLarge` flags the specific case where we aborted the query because its
  // output blew past MAX_OUTPUT_BYTES. The caller uses it to skip the
  // temporal-rewrite retry (re-running would just hit the same wall) and to
  // know the error is a deliberate cap, not a real bq failure.
  | { ok: false; error: string; partialJsonText?: string; tooLarge?: boolean };

// Hard ceiling on bq stdout we'll buffer. The result is accumulated into a
// single JS string, and V8 caps string length at ~536 MB on 64-bit — pushing
// past it truncates the buffer mid-token, which then surfaces as a misleading
// "Unterminated string in JSON" parse error after a long wait. This extension
// is explicitly not built to render multi-hundred-MB / multi-million-row
// results (that would freeze the grid anyway), so we stop well short of the
// V8 limit and tell the user to narrow the query. Generous enough that normal
// large results (hundreds of thousands of rows) still come through whole.
const MAX_OUTPUT_MB = 256;
const MAX_OUTPUT_BYTES = MAX_OUTPUT_MB * 1024 * 1024;
const RESULT_TOO_LARGE_MESSAGE =
  `Result too large to display. The query produced more than ${MAX_OUTPUT_MB} MB of output, ` +
  `so it was stopped to keep VS Code responsive. Add a LIMIT clause (or a narrower WHERE / ` +
  `fewer columns) and run again.`;

export interface RunQueryHandle {
  promise: Promise<RunQueryResult>;
  cancel: () => void;
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
  // bq --format=json sometimes emits an error blob like
  // { "error": { "message": "...", "code": 400, ... } } on non-zero exit.
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
      // fall through and return the raw text
    }
  }
  return trimmed;
}

export function runQuery(sql: string, jobId?: string): RunQueryHandle {
  let cancelFn: () => void = () => {};
  const promise = new Promise<RunQueryResult>((resolve) => {
    const isWindows = process.platform === 'win32';
    const args = [
      'query',
      '--quiet',
      '--use_legacy_sql=false',
      '--format=json',
      // bq query defaults --max_rows to 100, truncating the JSON array silently.
      // Lift the cap so the result reflects the SQL's own LIMIT (or all rows).
      '--max_rows=1000000',
    ];
    // Setting --job_id ourselves means we can later locate child jobs via
    // `bq ls --jobs --parent_job_id=<our id>` without racing against other
    // jobs in the user's project. Required for the M7 per-statement schema
    // enrichment path.
    if (jobId) args.push(`--job_id=${jobId}`);
    // Force bq's Python runtime to emit UTF-8 regardless of the OS code page.
    // PYTHONUTF8=1 (PEP 540) enables UTF-8 mode globally — overrides locale
    // and the default stdio encoding before any user code runs. PYTHONIOENCODING
    // is a belt-and-braces backup for older Python versions that don't honor
    // PYTHONUTF8. Without these, on Windows in non-UTF-8 locales (e.g. CP1252)
    // bq's stdout writer replaces unencodable chars with U+FFFD before bytes
    // ever leave the process.
    const child = spawn('bq', args, {
      shell: isWindows,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });

    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    let cancelled = false;
    // Set when we abort because output exceeded MAX_OUTPUT_BYTES. Distinct
    // from `cancelled` so the close/error handlers below know not to do the
    // expensive error-extraction work (which would re-touch the huge buffer).
    let tooLarge = false;

    const settle = (result: RunQueryResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    cancelFn = () => {
      if (settled || cancelled) {
        return;
      }
      cancelled = true;
      if (typeof child.pid === 'number') {
        // tree-kill walks descendants — required on Windows where `bq` is a .cmd
        // shim wrapped by cmd.exe; child.kill() would only terminate cmd.exe.
        treeKill(child.pid, 'SIGTERM', () => {});
      } else {
        try { child.kill('SIGTERM'); } catch { /* ignored */ }
      }
      // Hand back whatever stdout we had buffered so the caller can try to
      // salvage completed statements from a mid-script cancel. bq streams its
      // top-level array incrementally so the buffer is usually a partial
      // valid prefix.
      settle({ ok: false, error: CANCELLED_MESSAGE, partialJsonText: stdout });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (cancelled || tooLarge) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        // Abort early: no point streaming (and buffering) hundreds more MB we
        // can't render, and crossing V8's max string length would truncate
        // the buffer and surface a misleading parse error. Kill the process
        // tree and report the cap clearly.
        tooLarge = true;
        if (typeof child.pid === 'number') {
          treeKill(child.pid, 'SIGTERM', () => {});
        } else {
          try { child.kill('SIGTERM'); } catch { /* ignored */ }
        }
        settle({ ok: false, error: RESULT_TOO_LARGE_MESSAGE, tooLarge: true });
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (cancelled) return;
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (cancelled || tooLarge) {
        return;
      }
      if (err.code === 'ENOENT') {
        settle({ ok: false, error: MISSING_BQ_MESSAGE });
      } else {
        settle({ ok: false, error: err.message });
      }
    });

    child.on('close', (code) => {
      // tooLarge already settled with a clear message; bail before the
      // error-extraction below re-scans / JSON.parses the multi-hundred-MB
      // buffer we deliberately stopped accumulating.
      if (cancelled || tooLarge) {
        return;
      }
      if (code === 0) {
        settle({ ok: true, jsonText: stdout });
        return;
      }
      const combined = `${stderr}\n${stdout}`.trim();
      if (NOT_FOUND_PATTERNS.some((p) => p.test(combined))) {
        settle({ ok: false, error: MISSING_BQ_MESSAGE });
        return;
      }
      // `bq` writes query-validation errors (syntax errors, auth errors, etc.)
      // to stdout, not stderr. Prefer stderr when it has content, fall back to
      // stdout (which under --format=json may be a JSON error blob — extract
      // `.error.message` if so), then a generic message.
      const message =
        stderr.trim() ||
        extractErrorFromStdout(stdout) ||
        `bq exited with code ${code}`;
      settle({ ok: false, error: message });
    });

    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (cancelled) {
        return;
      }
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
