import * as vscode from 'vscode';
import { runQuery } from '../bq/runQuery';
import { dryRunQuery } from '../bq/dryRun';
import { fetchChildJobs, generateJobId, type ChildJobInfo } from '../bq/childJobs';
import {
  parseMultiStatementOutput,
  splitSqlForDisplay,
  alignSqlPreviewsToResults,
  filterOutputProducingChildren,
  type StatementResult,
} from '../bq/multiStatement';
import type { ResultViewProvider, RunHandle } from '../panel/resultViewProvider';
import type { StatementOutcome, TabResult, TimingInfo } from '../panel/types';
import {
  maybeRewriteForTemporalFidelity,
  maybeRewriteScriptForTemporalFidelity,
  splitStatementsForScript,
  type PerStatementSchema,
} from '../bq/rewriteTemporal';

export async function runSelectionCommand(provider: ResultViewProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const doc = editor.document;
  if (doc.uri.scheme !== 'file' || !doc.uri.fsPath.toLowerCase().endsWith('.sql')) {
    return;
  }
  const selectionText = doc.getText(editor.selection);
  if (!selectionText.trim()) {
    return;
  }

  await runSqlForUri(provider, doc.uri, selectionText);
}

/**
 * Shared run-pipeline used by both runSelection (Shift+Enter / Run Selection
 * button) and runFile (Run File button). Caller is responsible for resolving
 * the SQL text from the editor — selection range vs whole document — and for
 * the .sql/file-scheme guard. Everything after that (dry-run, auto-wrap,
 * real query, enrichment, parse, multi-stmt routing, cancellation) lives
 * here so the two entry points stay byte-identical in behaviour.
 */
export async function runSqlForUri(
  provider: ResultViewProvider,
  uri: vscode.Uri,
  sqlText: string,
): Promise<void> {
  // Pin the source editor out of preview mode. Running a query is a
  // deliberate action, so the file becomes a "kept" (permanent) tab — exactly
  // as if the user had double-clicked it. This is what keeps its result alive:
  // a permanent tab is never silently replaced when you navigate to another
  // preview file, so the result only goes away when the tab is actually
  // closed. The active editor is still the run target at this point (the
  // command read it synchronously just before calling us). Best-effort.
  try {
    await vscode.commands.executeCommand('workbench.action.keepEditor');
  } catch {
    // No active preview editor / command unavailable — harmless.
  }
  await provider.runForUri(uri, (): RunHandle => {
    let cancelled = false;
    let currentCancel: () => void = () => {};

    const promise: Promise<TabResult> = (async (): Promise<TabResult> => {
      const tStart = performance.now();
      // Generate our own job_id upfront — we need it to find child jobs
      // after the script completes (per-statement schema enrichment).
      // Mutable because the auto-wrap retry path below mints a fresh id
      // (the wrapped attempt may have registered this id server-side).
      let jobId = generateJobId();

      // Per-phase timing (M11).
      let dryMs = 0;
      let realMs = 0;

      // Dry-run first. Its schema drives the auto-wrap decision (see
      // rewriteTemporal.ts) — bq's --format=json silently drops microseconds
      // and the ` UTC` suffix from temporal columns, so when the query
      // contains TIMESTAMP / DATETIME / TIME columns (including nested
      // inside STRUCTs / ARRAYs) we rewrite into a CTE that wraps each one
      // in the appropriate FORMAT_* function. This costs us the concurrency
      // we gained in the post-M6 perf patch — the real query waits for
      // the dry-run(s) to finish — but it's the only way to get microsecond
      // fidelity through the bq CLI without rewriting the user's SQL by
      // hand. DDL / DML / scripts with control flow / queries with no
      // temporal columns pass through unchanged.
      const dry = dryRunQuery(sqlText);
      currentCancel = () => dry.cancel();
      const dryResult = await dry.promise;
      dryMs = Math.round(performance.now() - tStart);

      if (cancelled) {
        currentCancel = () => {};
        return buildCancelledTabResult(sqlText, undefined);
      }
      if (!dryResult.ok) {
        currentCancel = () => {};
        return { kind: 'error', message: dryResult.error };
      }

      // Auto-wrap decision branches on whether the selection is single- or
      // multi-statement. Single SELECTs get the cheap path. Multi-statement
      // scripts require an extra dry-run per statement to learn each one's
      // schema (the script-level dry-run reports only the final statement's
      // shape). If any per-statement dry-run fails — typical when a
      // statement references a DECLARE'd variable from earlier in the
      // script — the rewriter bails and we run the script unwrapped.
      const stmtPieces = splitStatementsForScript(sqlText);
      let effectiveSql = sqlText;
      if (stmtPieces.length === 1) {
        const rewrite = maybeRewriteForTemporalFidelity(sqlText, dryResult.schema);
        if (rewrite.rewritten) effectiveSql = rewrite.rewritten;
      } else if (stmtPieces.length > 1) {
        const perStmt = await fetchPerStatementSchemas(stmtPieces, (cb) => { currentCancel = cb; });
        if (cancelled) {
          currentCancel = () => {};
          return buildCancelledTabResult(sqlText, undefined);
        }
        // Pass the script-level dry-run schema as a fallback for scripts
        // where per-statement dry-runs fail (e.g. DECLARE + SELECT). The
        // script-level schema describes the FINAL output-producing
        // statement, so the rewriter wraps only that last SELECT.
        const rewrite = maybeRewriteScriptForTemporalFidelity(perStmt, dryResult.schema);
        if (rewrite.rewritten) effectiveSql = rewrite.rewritten;
      }

      const tRealStart = performance.now();
      const real = runQuery(effectiveSql, jobId);
      currentCancel = () => real.cancel();
      let realResult = await real.promise;
      realMs = Math.round(performance.now() - tRealStart);

      if (cancelled) {
        currentCancel = () => {};
        const partial = !realResult.ok ? realResult.partialJsonText : undefined;
        return buildCancelledTabResult(sqlText, partial);
      }

      // Safety net: if the auto-wrap produced SQL that bq rejected, retry
      // with the user's original SQL. This guarantees no rewrite shape we
      // didn't anticipate (anonymous temporal columns are already gated,
      // but other edge cases like exotic ORDER BY semantics, future bq
      // types, etc. may still surface) can block the user's workflow.
      // The dry-run was on the original SQL so if THAT succeeded we know
      // the user's query itself is valid — a real-query failure on the
      // wrapped version is almost certainly the wrap's fault.
      if (!realResult.ok && !realResult.tooLarge && effectiveSql !== sqlText) {
        // The wrapped attempt above may have registered its job_id with
        // BigQuery before bq returned the error, so reusing the same id
        // here would be rejected as "Already Exists: Job ...". Mint a fresh
        // id for the retry and reassign `jobId` so the enrichment path below
        // (fetchChildJobs) keys off whichever id actually produced output.
        jobId = generateJobId();
        const realRetry = runQuery(sqlText, jobId);
        currentCancel = () => realRetry.cancel();
        const retryResult = await realRetry.promise;
        realMs = Math.round(performance.now() - tRealStart);
        if (cancelled) {
          currentCancel = () => {};
          const partial = !retryResult.ok ? retryResult.partialJsonText : undefined;
          return buildCancelledTabResult(sqlText, partial);
        }
        if (retryResult.ok) {
          realResult = retryResult;
        } else {
          // Both failed. Surface the retry's error since it's against the
          // user's actual SQL (not our wrap), which is more diagnostic.
          realResult = retryResult;
        }
      }
      if (!realResult.ok) {
        currentCancel = () => {};
        return { kind: 'error', message: realResult.error };
      }

      // Detect multi-statement BEFORE deciding whether to enrich. Single
      // SELECTs (the M6 path) skip enrichment entirely — no extra bq calls,
      // zero regression in latency.
      const isLikelyMultiStatement = looksLikeMultiStatementOutput(realResult.jsonText);
      let childJobs: ChildJobInfo[] = [];

      if (isLikelyMultiStatement) {
        // Fire bq ls + per-SELECT bq show --schema. Failure here is
        // non-fatal: we still render the script, just without correct
        // column order for non-last SELECTs (M6 fallback behaviour).
        const enrich = fetchChildJobs(jobId);
        currentCancel = enrich.cancel;
        const enrichResult = await enrich.promise;
        if (cancelled) {
          currentCancel = () => {};
          return buildCancelledTabResult(sqlText, undefined);
        }
        if (enrichResult.ok) {
          childJobs = enrichResult.children;
        }
      }
      currentCancel = () => {};

      try {
        const tParseStart = performance.now();
        const statements = parseMultiStatementOutput(realResult.jsonText, dryResult.schema, childJobs);
        const parseMs = Math.round(performance.now() - tParseStart);
        const totalMs = Math.round(performance.now() - tStart);
        const timing: TimingInfo = { totalMs, dryMs, realMs, parseMs };
        return buildTabResultFromStatements(sqlText, statements, childJobs, timing);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'error', message: `Failed to parse JSON: ${message}` };
      }
    })();

    return {
      promise,
      cancel: () => {
        cancelled = true;
        currentCancel();
      },
    };
  });
}

/**
 * Heuristic: does this bq output look multi-statement? Used to gate the
 * extra bq ls + bq show round-trips so single-statement queries don't
 * pay the enrichment cost. A flat array of row objects is single-stmt;
 * an array containing strings or nested arrays is multi.
 */
function looksLikeMultiStatementOutput(jsonText: string): boolean {
  const trimmed = jsonText.trim();
  if (!trimmed) return true; // empty == script-with-no-output (multi)
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return false;
    if (parsed.length === 0) return true;
    // Single-statement output: array of plain row objects.
    return parsed.some(
      (el) =>
        typeof el === 'string' ||
        (Array.isArray(el)),
    );
  } catch {
    return false;
  }
}

function toOutcome(s: StatementResult): StatementOutcome {
  return s;
}

/**
 * Decide whether to render as the single-statement M6 path (kind: 'ok')
 * or the multi-statement overview path (kind: 'multi'). The rule: ONE
 * SELECT statement and nothing else → unwrap to the single-statement
 * shape so the existing UI is byte-identical to M6. Everything else
 * (multiple statements, single DDL/DML/script result, mixed) → multi.
 *
 * SQL previews come from child-job stackFrame text when enrichment
 * succeeded (precise per-statement SQL straight from BigQuery's parser);
 * otherwise we fall back to the best-effort `;`-split for display.
 */
function buildTabResultFromStatements(
  selectionText: string,
  statements: StatementResult[],
  childJobs: ChildJobInfo[],
  timing: TimingInfo,
): TabResult {
  if (statements.length === 1 && statements[0].kind === 'select') {
    const s = statements[0];
    return { kind: 'ok', columns: s.columns, rows: s.rows, timing };
  }
  const sqlPreviews = buildSqlPreviews(selectionText, statements.length, childJobs);
  return {
    kind: 'multi',
    statements: statements.map(toOutcome),
    sqlPreviews,
    timing,
  };
}

function buildSqlPreviews(
  selectionText: string,
  statementCount: number,
  childJobs: ChildJobInfo[],
): (string | null)[] {
  // Prefer enriched per-statement text when available (BigQuery's own
  // parse — handles BEGIN/END, ';' in strings, comments, etc. correctly).
  if (childJobs.length > 0) {
    const previews: (string | null)[] = [];
    // Same output-element <-> child alignment used for schema mapping
    // (evaluationKind STATEMENT, in source order), so the SQL labels in the
    // overview line up with their results even when a non-SELECT output
    // statement (ASSERT / EXPORT DATA / CALL / ...) precedes a SELECT.
    const outputProducing = filterOutputProducingChildren(childJobs);
    for (let i = 0; i < statementCount; i++) {
      const child = outputProducing[i];
      previews.push(child?.statementText?.trim() || null);
    }
    // If enrichment misaligned (rare — counts didn't match), fall through
    // to the best-effort split so the column isn't all dashes.
    if (previews.every((p) => p === null)) {
      const pieces = splitSqlForDisplay(selectionText);
      return alignSqlPreviewsToResults(pieces, statementCount);
    }
    return previews;
  }
  const pieces = splitSqlForDisplay(selectionText);
  return alignSqlPreviewsToResults(pieces, statementCount);
}

/**
 * Per-statement dry-run for the multi-statement temporal-fidelity path.
 *
 * For statement N, we dry-run `statements[0..N]` concatenated — that way
 * BigQuery has all prior script state (DECLAREs, SETs, CREATE TEMP
 * TABLEs, etc.) in scope, and the dry-run reports the schema of the LAST
 * statement (which is statement N, the one we want).
 *
 * Costs N dry-runs in total but each is free at BigQuery billing.
 * Latency is N × per-dry-run-roundtrip (~1-2s on a slow connection).
 *
 * A statement that fails the prefix dry-run (rare — would mean the
 * partial script itself is invalid) returns schema=null; the rewriter
 * passes that statement through unwrapped but tries to wrap the others.
 *
 * Cancellation: pass a single `setCancel` callback that the outer
 * runSelection loop uses to plumb cancellation into the in-flight
 * dry-runs. Each call replaces the previous cancel binding so the most
 * recent in-flight dry-run is the one cancelled.
 */
async function fetchPerStatementSchemas(
  stmtPieces: string[],
  setCancel: (cb: () => void) => void,
): Promise<PerStatementSchema[]> {
  const out: PerStatementSchema[] = [];
  for (let i = 0; i < stmtPieces.length; i++) {
    const sql = stmtPieces[i];
    // Prefix dry-run: everything up to and including statement i.
    // BigQuery returns the schema of the LAST statement (= sql), so we
    // get statement i's schema with all prior state in effect.
    const prefix = stmtPieces.slice(0, i + 1).join(';\n');
    const dry = dryRunQuery(prefix);
    setCancel(() => dry.cancel());
    const result = await dry.promise;
    if (result.ok) {
      out.push({ index: i, sql, schema: result.schema });
    } else {
      // Partial script invalid — extremely rare, but bail cleanly so the
      // outer flow still gets a chance to run the full script.
      out.push({ index: i, sql, schema: null });
    }
  }
  return out;
}

function buildCancelledTabResult(
  selectionText: string,
  partialJsonText: string | undefined,
): TabResult {
  const salvaged = salvagePartialStatements(partialJsonText);
  if (salvaged.length === 0) {
    return { kind: 'error', message: 'Query cancelled.' };
  }
  const withCancelled: StatementResult[] = [...salvaged, { kind: 'cancelled' }];
  const pieces = splitSqlForDisplay(selectionText);
  const sqlPreviews = alignSqlPreviewsToResults(pieces, withCancelled.length);
  return {
    kind: 'multi',
    statements: withCancelled.map(toOutcome),
    sqlPreviews,
  };
}

function salvagePartialStatements(partial: string | undefined): StatementResult[] {
  if (!partial) return [];
  const trimmed = partial.trim();
  if (!trimmed) return [];

  const direct = tryParseStatements(trimmed);
  if (direct) return direct;

  const lastSep = trimmed.lastIndexOf('\n,');
  if (lastSep > 0) {
    const head = trimmed.slice(0, lastSep);
    const closed = head + '\n]';
    const result = tryParseStatements(closed);
    if (result) return result;
  }

  const ensureOpen = trimmed.startsWith('[') ? trimmed : `[${trimmed}`;
  const closed = ensureOpen.endsWith(']') ? ensureOpen : `${ensureOpen}]`;
  return tryParseStatements(closed) ?? [];
}

function tryParseStatements(text: string): StatementResult[] | null {
  try {
    const results = parseMultiStatementOutput(text);
    if (results.length === 1 && results[0].kind === 'script-completed') {
      return null;
    }
    if (results.length === 1 && results[0].kind === 'error') {
      return null;
    }
    return results;
  } catch {
    return null;
  }
}
