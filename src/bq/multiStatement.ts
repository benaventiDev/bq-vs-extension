import type { SchemaField } from './dryRun';
import type { ChildJobInfo } from './childJobs';
import { parseJson, type ParsedColumn, type ParsedRow } from './parseJson';

/**
 * One entry per statement that produced an output element in bq's heterogeneous
 * top-level array. Statements without output (DECLARE / SET / IF / WHILE that
 * doesn't print) are not enumerated here — bq doesn't return an element for
 * them. Errors that abort the script are returned as a single 'error' entry by
 * the caller (bq does not return partial results on script error).
 */
export type StatementResult =
  | { kind: 'select'; columns: ParsedColumn[]; rows: ParsedRow[]; executionMs?: number | null }
  | { kind: 'dml'; rowsAffected: number; message: string; executionMs?: number | null }
  | { kind: 'ddl'; message: string; executionMs?: number | null }
  | { kind: 'script-completed'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

const DML_PREFIX_RE = /^Number of affected rows:\s*(\d+)/i;
// Empirically: "Created ...", "Dropped ...", "Altered ...", "Truncated ..."
// — anything that bq emits as a status string for non-DML side effects.
const DDL_VERBS = ['Created', 'Dropped', 'Altered', 'Truncated', 'Replaced'];

function isDdlStatusString(s: string): boolean {
  const trimmed = s.trimStart();
  return DDL_VERBS.some((v) => trimmed.startsWith(v));
}

function classifyStatusString(s: string, child?: ChildJobInfo): StatementResult {
  const execMs = child?.executionMs ?? null;
  // Prefer the child-job's authoritative DML row count when present; falls
  // back to parsing "Number of affected rows: N" from the status string.
  if (child && isDmlType(child.statementType) && child.numDmlAffectedRows !== null) {
    const n = child.numDmlAffectedRows;
    return {
      kind: 'dml',
      rowsAffected: n,
      message: `${n.toLocaleString()} row${n === 1 ? '' : 's'} affected`,
      executionMs: execMs,
    };
  }
  const dml = DML_PREFIX_RE.exec(s);
  if (dml) {
    const n = parseInt(dml[1], 10);
    const rowsAffected = Number.isFinite(n) ? n : 0;
    const message = `${rowsAffected.toLocaleString()} row${rowsAffected === 1 ? '' : 's'} affected`;
    return { kind: 'dml', rowsAffected, message, executionMs: execMs };
  }
  if (isDdlStatusString(s)) {
    return { kind: 'ddl', message: s.trim(), executionMs: execMs };
  }
  // Unknown status string — surface verbatim as a DDL-style banner so the user
  // can see exactly what bq said. Keeps us forward-compatible with new verbs.
  return { kind: 'ddl', message: s.trim(), executionMs: execMs };
}

const DML_TYPES = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);
function isDmlType(t: string): boolean {
  return DML_TYPES.has(t.toUpperCase());
}

const OUTPUT_PRODUCING_TYPES = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'CREATE_TABLE',
  'CREATE_TABLE_AS_SELECT',
  'CREATE_VIEW',
  'CREATE_MATERIALIZED_VIEW',
  'CREATE_FUNCTION',
  'CREATE_PROCEDURE',
  'CREATE_SCHEMA',
  'CREATE_SNAPSHOT_TABLE',
  'DROP_TABLE',
  'DROP_VIEW',
  'DROP_FUNCTION',
  'DROP_PROCEDURE',
  'DROP_SCHEMA',
  'ALTER_TABLE',
  'ALTER_VIEW',
  'TRUNCATE_TABLE',
]);

/**
 * Filter the full child-jobs list down to just the children that produce a
 * top-level element in bq's output array, lined up positionally (in source
 * order) with that array.
 *
 * Primary signal: BigQuery's own `evaluationKind`. A child with
 * evaluationKind === 'STATEMENT' is a top-level statement that emits exactly
 * one output element; 'EXPRESSION' children (subqueries inside SET / an IF
 * condition) and control flow (DECLARE/SET/IF/WHILE — which create no child
 * job at all) do not. Verified empirically across SELECT / INSERT / UPDATE /
 * DELETE / MERGE / CREATE / ASSERT / WHILE-loops / SET-subqueries: STATEMENT
 * children align 1:1 with the output array. This is robust to ASSERT /
 * EXPORT DATA / CALL / LOAD DATA and any future statement type — unlike the
 * old statement-type allow-list, whose omissions silently shifted a later
 * SELECT onto the wrong child's schema (PIPE-1), and which also mis-handled
 * EXPRESSION subquery children.
 *
 * Fallback: older bq that doesn't report evaluationKind produces no STATEMENT
 * matches; we then fall back to the legacy statement-type allow-list so
 * behaviour never regresses.
 */
export function filterOutputProducingChildren(children: ChildJobInfo[]): ChildJobInfo[] {
  const byEvaluationKind = children.filter((c) => c.evaluationKind === 'STATEMENT');
  if (byEvaluationKind.length > 0) return byEvaluationKind;
  return children.filter((c) => OUTPUT_PRODUCING_TYPES.has(c.statementType.toUpperCase()));
}

/**
 * Parse the result of one bq query --format=json invocation against an arbitrary
 * SQL selection (single statement OR multi-statement script).
 *
 * bq's output shape depends on the selection:
 *  - Single SELECT       → flat array of row objects: `[{a:1}, {a:2}]`
 *  - Multi-statement     → top-level array of elements, one per statement that
 *                          produced output. Each element is either:
 *                            • a status string ("Created ...", "Number of
 *                              affected rows: N", etc.) — for DDL/DML
 *                            • a JSON array of row objects — for SELECT
 *  - Pure script (no outputs)  → empty top-level array `[]`
 *
 * The `schema` parameter (from M6's dry-run) is the schema of the LAST
 * statement only — bq's dry-run on a multi-statement script returns one
 * combined schema, which corresponds to the last SELECT. For earlier SELECTs
 * the caller can optionally supply `childJobs` (enriched per-statement
 * metadata fetched via bq ls + bq show) to give them schema too, restoring
 * SELECT column order across the entire script. When `childJobs` is absent,
 * earlier SELECTs fall back to value-based inference (alphabetical order).
 */
export function parseMultiStatementOutput(
  jsonText: string,
  schema?: SchemaField[],
  childJobs?: ChildJobInfo[],
): StatementResult[] {
  const trimmed = jsonText.trim();
  if (!trimmed) {
    return [{ kind: 'script-completed', message: 'Script job has finished.' }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [{ kind: 'error', message: `Failed to parse bq output: ${msg}` }];
  }

  // Pure script with no output statements (e.g. DECLARE + SET).
  if (Array.isArray(parsed) && parsed.length === 0) {
    return [{ kind: 'script-completed', message: 'Script job has finished.' }];
  }

  // Single-SELECT case: top-level is a flat array of row objects (not a
  // nested array). Parse with M6's schema-aware path so column order is
  // preserved.
  if (Array.isArray(parsed) && parsed.every((el) => isRowObject(el))) {
    const single = parseJson(trimmed, schema);
    return [{ kind: 'select', columns: single.columns, rows: single.rows }];
  }

  // Multi-statement: each element is a status string OR a rowset array.
  if (Array.isArray(parsed)) {
    const lastSelectIdx = findLastSelectIndex(parsed);
    // Build the index mapping from output-array positions to childJobs.
    // bq's output array enumerates statements that produced output, in
    // source order. childJobs (when supplied) enumerates ALL child jobs in
    // source order — including DECLARE/SET that don't appear in the output
    // array. The mapper skips over those so the i-th output element lines
    // up with the i-th output-producing child.
    const outputProducingChildren = childJobs
      ? filterOutputProducingChildren(childJobs)
      : [];

    return parsed.map((el, idx): StatementResult => {
      const child = outputProducingChildren[idx];
      if (typeof el === 'string') {
        return classifyStatusString(el, child);
      }
      if (Array.isArray(el)) {
        // Prefer per-statement schema from the child job (correct SELECT
        // column order). Fall back to the dry-run schema only for the last
        // SELECT (M6 behaviour). Earliest SELECTs without enrichment use
        // value-inference (alphabetical, M6 fallback).
        const childSchema = child?.schema ?? null;
        const fallbackSchema = idx === lastSelectIdx ? schema : undefined;
        const effective = childSchema ?? fallbackSchema;
        const rowsetText = JSON.stringify(el);
        const ps = parseJson(rowsetText, effective);
        return {
          kind: 'select',
          columns: ps.columns,
          rows: ps.rows,
          executionMs: child?.executionMs ?? null,
        };
      }
      return {
        kind: 'error',
        message: `Unexpected statement output shape: ${JSON.stringify(el).slice(0, 200)}`,
      };
    });
  }

  // Top-level wasn't an array. Treat as a single SELECT with one row (matches
  // M6's parseJson behavior).
  const fallback = parseJson(trimmed, schema);
  return [{ kind: 'select', columns: fallback.columns, rows: fallback.rows }];
}

function isRowObject(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date)
  );
}

function findLastSelectIndex(elements: unknown[]): number {
  for (let i = elements.length - 1; i >= 0; i--) {
    if (Array.isArray(elements[i])) return i;
  }
  return -1;
}

/**
 * Best-effort split of a SQL selection on `;` for *display only* in the
 * overview table. Naive: does not handle BEGIN/END blocks, string literals
 * containing `;`, or `;` inside comments. The user explicitly accepted this
 * trade-off — execution still sends the full selection to bq, so result
 * correctness is unaffected; only the per-row SQL preview may misalign for
 * pathological scripts.
 *
 * Returns an array of statement-text snippets (trimmed, empty pieces removed).
 */
export function splitSqlForDisplay(sql: string): string[] {
  const pieces: string[] = [];
  let buf = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === ';') {
      const trimmed = buf.trim();
      if (trimmed) pieces.push(trimmed);
      buf = '';
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) pieces.push(tail);
  return pieces;
}

/**
 * Align a list of per-statement display strings (from `splitSqlForDisplay`) to
 * a list of bq statement results. The two lists may diverge in length because:
 *  - Script control statements (DECLARE, SET, IF, …) don't produce bq output
 *    elements, but DO appear in the split.
 *  - Pathological splits can produce more/fewer pieces than statements.
 *
 * Strategy: return one preview per result, taking pieces from the end (the
 * last N pieces of the split align with the last N output-producing
 * statements, which is true when control statements appear at the start —
 * the common DECLARE-then-query pattern). For mid-script control statements
 * this is a best-effort and may misalign; surfacing "—" in the column is
 * preferable to a confidently-wrong preview.
 */
export function alignSqlPreviewsToResults(
  pieces: string[],
  resultCount: number,
): (string | null)[] {
  if (resultCount <= 0) return [];
  if (pieces.length === resultCount) return pieces;
  if (pieces.length === 0) return new Array(resultCount).fill(null);
  if (pieces.length < resultCount) {
    // Fewer pieces than statements — unusual. Pad nulls at the front so the
    // last pieces line up with the last statements.
    const pad: (string | null)[] = new Array(resultCount - pieces.length).fill(null);
    return [...pad, ...pieces];
  }
  // More pieces than statements — control statements at the start are the
  // common cause. Take the last N pieces.
  return pieces.slice(pieces.length - resultCount);
}
