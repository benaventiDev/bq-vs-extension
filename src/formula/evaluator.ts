// Evaluator for the M8 formula language. Walks the AST against a single row
// (a column-name-to-value map) plus a column type table, and returns one of:
//
//   - a value (number / string / boolean / Date / null) when the formula
//     evaluated cleanly
//   - a "did not apply" sentinel when a runtime issue (missing column, type
//     mismatch) means the rule should silently skip this row but the rule
//     itself should not be deleted (the non-blocking error path)
//
// The "did not apply" path differs from a boolean FALSE: FALSE means the
// rule successfully evaluated but the row didn't match; "did not apply"
// means a referenced column wasn't in the result, or a type mismatch made
// the comparison meaningless. Caller treats both as "rule doesn't paint
// this row" for the data, but a rule that returned "did not apply" for
// EVERY row triggers a warning indicator in the rules list.

import type { Expr } from './parser';
import type { ParsedColumn, ParsedRow, ColumnType } from '../bq/parseJson';

export type FormulaValue = number | string | boolean | Date | null;

export const NOT_APPLIED = Symbol('formula-not-applied');
export type EvaluationOutcome = FormulaValue | typeof NOT_APPLIED;

export interface EvaluationContext {
  // Case-insensitive column lookup table (lowercased name -> original name).
  // Built once per result by the caller; passed in every evaluation so we
  // don't rebuild it per-row.
  columnIndex: Map<string, string>;
  columnTypes: Map<string, ColumnType>;
  // Full row set for aggregations (COUNTIF / COUNTIFS). Optional — when
  // omitted, aggregation functions return NOT_APPLIED so the rule shows
  // its warning indicator. Production callers (computeRuleColors and
  // refreshModalStatus) supply this; tests can opt in.
  allRows?: ParsedRow[];
  // Memoization for aggregation results. One cache entry per
  // (function-name, column, evaluated-criterion) tuple. Lives for one
  // evaluation pass so a 5K-row grid with one COUNTIF rule is O(N) total,
  // not O(N²).
  countCache?: Map<string, number>;
}

export function buildContext(
  columns: ParsedColumn[],
  options?: { allRows?: ParsedRow[]; countCache?: Map<string, number> },
): EvaluationContext {
  const columnIndex = new Map<string, string>();
  const columnTypes = new Map<string, ColumnType>();
  for (const c of columns) {
    columnIndex.set(c.field.toLowerCase(), c.field);
    columnTypes.set(c.field, c.type);
  }
  return {
    columnIndex,
    columnTypes,
    allRows: options?.allRows,
    countCache: options?.countCache,
  };
}

export interface EvalReport {
  // Set to true if at least one column referenced by the formula was missing
  // from the current result. Drives the rules-list warning indicator.
  missingColumn: boolean;
  // First missing column name (case as written in the formula).
  missingColumnName: string | null;
  // Set when a runtime type mismatch was detected (e.g. comparing string to
  // number). Same UI treatment as missingColumn.
  typeMismatch: boolean;
  // A human-friendly explanation when the mismatch is specifically a date
  // compared to a non-date string — surfaced in the modal status (FORM-6).
  typeMismatchHint: string | null;
}

export interface MatchOutcome {
  matched: boolean;
  report: EvalReport;
}

export function matches(
  ast: Expr,
  row: ParsedRow,
  ctx: EvaluationContext,
): MatchOutcome {
  const report: EvalReport = { missingColumn: false, missingColumnName: null, typeMismatch: false, typeMismatchHint: null };
  const v = evalExpr(ast, row, ctx, report);
  if (v === NOT_APPLIED) {
    return { matched: false, report };
  }
  return { matched: isTruthy(v), report };
}

export function evaluate(
  ast: Expr,
  row: ParsedRow,
  ctx: EvaluationContext,
): { value: EvaluationOutcome; report: EvalReport } {
  const report: EvalReport = { missingColumn: false, missingColumnName: null, typeMismatch: false, typeMismatchHint: null };
  const value = evalExpr(ast, row, ctx, report);
  return { value, report };
}

function isTruthy(v: FormulaValue): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  return false;
}

function evalExpr(
  e: Expr,
  row: ParsedRow,
  ctx: EvaluationContext,
  report: EvalReport,
): EvaluationOutcome {
  switch (e.type) {
    case 'number':
      return e.value;
    case 'string':
      return e.value;
    case 'boolean':
      return e.value;
    case 'null':
      return null;
    case 'column': {
      const key = e.name.toLowerCase();
      const original = ctx.columnIndex.get(key);
      if (original === undefined) {
        if (!report.missingColumn) {
          report.missingColumn = true;
          report.missingColumnName = e.name;
        }
        return NOT_APPLIED;
      }
      const v = row[original];
      if (v === undefined) return null;
      // NUMERIC / BIGNUMERIC are stored verbatim as strings to preserve display
      // precision (DATA-1/2). Formula / conditional-format math needs a number,
      // so coerce on demand. This is double-precision — identical to the
      // pre-fix behaviour for these columns — while the grid still DISPLAYS the
      // exact string. Non-numeric stragglers fall through as the raw value.
      if (v !== null && typeof v === 'string' && ctx.columnTypes.get(original) === 'decimal') {
        const n = Number(v);
        if (!Number.isNaN(n)) return n;
      }
      // Temporal columns (DATE / DATETIME / TIMESTAMP) are stored verbatim as
      // strings for display precision. Formula comparisons need them to behave
      // as dates (chronological, not lexical), so coerce on demand via the same
      // parser every date function uses. Values that don't parse — or TIME
      // columns, which parseIsoDate doesn't handle — fall through as the raw
      // string (FORM-6).
      if (v !== null && typeof v === 'string') {
        const t = ctx.columnTypes.get(original);
        if (t === 'date' || t === 'datetime' || t === 'timestamp') {
          const d = parseIsoDate(v);
          if (d) return d;
        }
      }
      return v as FormulaValue;
    }
    case 'unary': {
      const operand = evalExpr(e.operand, row, ctx, report);
      if (operand === NOT_APPLIED) return NOT_APPLIED;
      if (e.op === 'NOT') {
        if (operand === null) return null;
        return !isTruthy(operand);
      }
      // unary minus
      if (operand === null) return null;
      if (typeof operand === 'number') return -operand;
      report.typeMismatch = true;
      return NOT_APPLIED;
    }
    case 'binary':
      return evalBinary(e.op, e.left, e.right, row, ctx, report);
    case 'call':
      return evalCall(e.name, e.args, row, ctx, report);
  }
}

function evalBinary(
  op: string,
  leftE: Expr,
  rightE: Expr,
  row: ParsedRow,
  ctx: EvaluationContext,
  report: EvalReport,
): EvaluationOutcome {
  // Short-circuit AND/OR — needed both for correctness with NULL propagation
  // and to avoid evaluating the second operand unnecessarily.
  if (op === 'AND' || op === 'OR') {
    const l = evalExpr(leftE, row, ctx, report);
    if (l === NOT_APPLIED) return NOT_APPLIED;
    const lTruthy = l === null ? null : isTruthy(l);
    if (op === 'AND') {
      if (lTruthy === false) return false;
      const r = evalExpr(rightE, row, ctx, report);
      if (r === NOT_APPLIED) return NOT_APPLIED;
      const rTruthy = r === null ? null : isTruthy(r);
      if (lTruthy === null || rTruthy === null) return null;
      return lTruthy && rTruthy;
    } else {
      if (lTruthy === true) return true;
      const r = evalExpr(rightE, row, ctx, report);
      if (r === NOT_APPLIED) return NOT_APPLIED;
      const rTruthy = r === null ? null : isTruthy(r);
      if (lTruthy === null && rTruthy === null) return null;
      return Boolean(lTruthy) || Boolean(rTruthy);
    }
  }

  const l = evalExpr(leftE, row, ctx, report);
  if (l === NOT_APPLIED) return NOT_APPLIED;
  const r = evalExpr(rightE, row, ctx, report);
  if (r === NOT_APPLIED) return NOT_APPLIED;

  if (op === '+' || op === '-' || op === '*' || op === '/') {
    if (l === null || r === null) return null;
    if (typeof l !== 'number' || typeof r !== 'number') {
      report.typeMismatch = true;
      return NOT_APPLIED;
    }
    if (op === '+') return l + r;
    if (op === '-') return l - r;
    if (op === '*') return l * r;
    // division
    if (r === 0) return null;
    return l / r;
  }

  // Comparison operators
  if (l === null || r === null) return null;

  // Date auto-coercion: when one side is a Date and the other is an ISO-ish
  // string, coerce the string to a Date.
  let lc: FormulaValue = l;
  let rc: FormulaValue = r;
  if (lc instanceof Date && typeof rc === 'string') {
    const d = parseIsoDate(rc);
    if (d) rc = d;
  } else if (rc instanceof Date && typeof lc === 'string') {
    const d = parseIsoDate(lc);
    if (d) lc = d;
  }

  if (op === '=' || op === '<>') {
    const eq = looseEquals(lc, rc);
    if (eq === null) {
      // Mismatched types -> compare as not-equal (no silent coercion).
      return op === '<>';
    }
    return op === '=' ? eq : !eq;
  }

  // Ordered comparisons: only valid for same-type pairs of number/date/string.
  const cmp = orderedCompare(lc, rc);
  if (cmp === null) {
    report.typeMismatch = true;
    // Friendlier hint for the common "date vs non-date text" slip — e.g.
    // date_col > "last week" (FORM-6).
    if (!report.typeMismatchHint) {
      if (lc instanceof Date && typeof rc === 'string') {
        report.typeMismatchHint = `Compared a date to the non-date text "${rc}" — wrap it in DATE("...") or use an ISO date like "2026-01-31".`;
      } else if (rc instanceof Date && typeof lc === 'string') {
        report.typeMismatchHint = `Compared a date to the non-date text "${lc}" — wrap it in DATE("...") or use an ISO date like "2026-01-31".`;
      }
    }
    return NOT_APPLIED;
  }
  if (op === '<') return cmp < 0;
  if (op === '<=') return cmp <= 0;
  if (op === '>') return cmp > 0;
  return cmp >= 0; // '>='
}

function looseEquals(a: FormulaValue, b: FormulaValue): boolean | null {
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  // Mixed type: per spec, not-equal (no silent auto-coercion).
  return null;
}

function orderedCompare(a: FormulaValue, b: FormulaValue): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return null;
}

function parseIsoDate(s: string): Date | null {
  // Accept all temporal string shapes parseJson recognises:
  //   DATE      → YYYY-MM-DD
  //   DATETIME  → YYYY-MM-DDTHH:MM:SS(.ffffff)?
  //   TIMESTAMP → YYYY-MM-DD HH:MM:SS(.ffffff)?( UTC)?
  // Built by hand rather than via `new Date(s)` because V8 doesn't parse
  // the space-separated TIMESTAMP form portably (and treats it as local
  // time in some Node versions). All forms land at UTC for comparison so
  // the result is reproducible regardless of the user's locale. JS Date
  // is millisecond-precision; if BQ emits microseconds we keep the first
  // three fractional digits — acceptable because formula comparisons that
  // would be sensitive to sub-millisecond differences aren't expressible
  // in the language anyway.
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(\s?UTC)?)?$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const day = Number(m[3]);
  if (m[4] === undefined) {
    return new Date(Date.UTC(year, mon - 1, day));
  }
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const ss = Number(m[6]);
  const frac = m[7] ?? '';
  const ms = frac ? Number((frac + '000').slice(0, 3)) : 0;
  return new Date(Date.UTC(year, mon - 1, day, hh, mm, ss, ms));
}

function evalCall(
  name: string,
  args: Expr[],
  row: ParsedRow,
  ctx: EvaluationContext,
  report: EvalReport,
): EvaluationOutcome {
  // Aggregations get a different evaluation path — they iterate ctx.allRows
  // and don't need per-arg pre-evaluation in the same shape.
  if (name === 'COUNTIF' || name === 'COUNTIFS') {
    return evalCountAgg(name, args, row, ctx, report);
  }

  // IF needs short-circuit semantics; evaluate condition first, then ONE branch.
  if (name === 'IF') {
    const cond = evalExpr(args[0], row, ctx, report);
    if (cond === NOT_APPLIED) return NOT_APPLIED;
    const truthy = cond === null ? false : isTruthy(cond);
    return evalExpr(truthy ? args[1] : args[2], row, ctx, report);
  }

  // AND / OR as functions also short-circuit.
  if (name === 'AND') {
    let sawNull = false;
    for (const a of args) {
      const v = evalExpr(a, row, ctx, report);
      if (v === NOT_APPLIED) return NOT_APPLIED;
      if (v === null) { sawNull = true; continue; }
      if (!isTruthy(v)) return false;
    }
    return sawNull ? null : true;
  }
  if (name === 'OR') {
    let sawNull = false;
    for (const a of args) {
      const v = evalExpr(a, row, ctx, report);
      if (v === NOT_APPLIED) return NOT_APPLIED;
      if (v === null) { sawNull = true; continue; }
      if (isTruthy(v)) return true;
    }
    return sawNull ? null : false;
  }

  // Everything else is strict: evaluate all args up-front, propagate NOT_APPLIED.
  const vals: FormulaValue[] = [];
  for (const a of args) {
    const v = evalExpr(a, row, ctx, report);
    if (v === NOT_APPLIED) return NOT_APPLIED;
    vals.push(v);
  }

  switch (name) {
    case 'NOT': {
      const v = vals[0];
      if (v === null) return null;
      return !isTruthy(v);
    }
    case 'MOD': {
      const a = vals[0]; const b = vals[1];
      if (a === null || b === null) return null;
      if (typeof a !== 'number' || typeof b !== 'number') { report.typeMismatch = true; return NOT_APPLIED; }
      if (b === 0) return null;
      return a - Math.floor(a / b) * b;
    }
    case 'ABS': {
      const v = vals[0];
      if (v === null) return null;
      if (typeof v !== 'number') { report.typeMismatch = true; return NOT_APPLIED; }
      return Math.abs(v);
    }
    case 'ROUND': {
      const a = vals[0]; const b = vals[1];
      if (a === null || b === null) return null;
      if (typeof a !== 'number' || typeof b !== 'number') { report.typeMismatch = true; return NOT_APPLIED; }
      const digits = Math.trunc(b);
      // Guard the 10^digits factor against over/underflow. Without this,
      // digits >= 309 -> factor Infinity and digits <= -324 -> factor 0, both
      // yielding NaN (rule silently never matches); a finite-but-large factor
      // can also push a*factor past MAX_DOUBLE -> Infinity (rule wrongly
      // matches). Mirror Sheets/Excel: rounding to more decimals than a double
      // can represent is a no-op; rounding to a place value larger than the
      // number collapses to 0 (FORM-4).
      if (Number.isNaN(digits)) { report.typeMismatch = true; return NOT_APPLIED; }
      if (digits > 308) return a;
      if (digits < -308) return 0;
      const factor = Math.pow(10, digits);
      const rounded = Math.round(a * factor) / factor;
      return Number.isFinite(rounded) ? rounded : a;
    }
    case 'CONTAINS': {
      const a = vals[0]; const b = vals[1];
      if (a === null || b === null) return null;
      if (typeof a !== 'string' || typeof b !== 'string') { report.typeMismatch = true; return NOT_APPLIED; }
      return a.includes(b);
    }
    case 'LEN': {
      const v = vals[0];
      if (v === null) return null;
      if (typeof v !== 'string') { report.typeMismatch = true; return NOT_APPLIED; }
      return v.length;
    }
    case 'LOWER': {
      const v = vals[0];
      if (v === null) return null;
      if (typeof v !== 'string') { report.typeMismatch = true; return NOT_APPLIED; }
      return v.toLowerCase();
    }
    case 'UPPER': {
      const v = vals[0];
      if (v === null) return null;
      if (typeof v !== 'string') { report.typeMismatch = true; return NOT_APPLIED; }
      return v.toUpperCase();
    }
    case 'YEAR':
    case 'MONTH':
    case 'DAY': {
      const v = vals[0];
      if (v === null) return null;
      const d = toDate(v);
      if (!d) { report.typeMismatch = true; return NOT_APPLIED; }
      // UTC extraction: parseIsoDate anchors all temporal values to UTC, so
      // the integer field reported here matches the date displayed in the
      // grid (which is the verbatim BQ string, also UTC).
      if (name === 'YEAR') return d.getUTCFullYear();
      if (name === 'MONTH') return d.getUTCMonth() + 1;
      return d.getUTCDate();
    }
    case 'TODAY': {
      // Use the user's LOCAL calendar date (their notion of "today") but anchor
      // at UTC midnight so it's comparable with parseIsoDate / date columns,
      // which are all UTC-anchored. A local-midnight Date would be a different
      // instant in any non-UTC zone, dropping today's rows from
      // `date_col >= TODAY()` rules (FORM-10).
      const now = new Date();
      return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    }
    case 'DATE': {
      const v = vals[0];
      if (v === null) return null;
      if (typeof v !== 'string') { report.typeMismatch = true; return NOT_APPLIED; }
      // Route through parseIsoDate so DATE() understands the same set of
      // formats parseJson recognises, and anchors UTC consistently with
      // every other date function in this evaluator.
      const d = parseIsoDate(v);
      if (!d) { report.typeMismatch = true; return NOT_APPLIED; }
      return d;
    }
    case 'ISNULL':
      return vals[0] === null;
    case 'ISBLANK':
      return vals[0] === null || vals[0] === '';
  }

  // Unreachable for parsed AST (parser validates function names), but keep
  // the path safe.
  report.typeMismatch = true;
  return NOT_APPLIED;
}

function toDate(v: FormulaValue): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    const d = parseIsoDate(v);
    if (d) return d;
    const generic = new Date(v);
    if (!Number.isNaN(generic.getTime())) return generic;
  }
  return null;
}

// ---------------------------------------------------------------------------
// COUNTIF / COUNTIFS — aggregations over the full result row set.
// ---------------------------------------------------------------------------

// A wildcard pattern is compiled to a flat token list fed to a linear,
// non-backtracking matcher (wildcardMatch) instead of a regex. The old
// regex form turned each `*`/`%` into `.*`, so `**`-style criteria compiled
// to `.*.*…` and could catastrophically backtrack — seconds-to-minutes for a
// single value (FORM-1).
type WildToken =
  | { kind: 'lit'; ch: string } // exact character
  | { kind: 'any' }             // ? or _  -> exactly one character
  | { kind: 'star' };           // * or %  -> zero or more characters

type Criterion =
  | { mode: 'value'; value: FormulaValue }
  // negate=true is a `<>`-prefixed wildcard ("not matching the pattern").
  | { mode: 'pattern'; tokens: WildToken[]; negate: boolean }
  | { mode: 'op'; op: '>' | '<' | '>=' | '<=' | '<>' | '='; operand: FormulaValue };

function evalCountAgg(
  fnName: 'COUNTIF' | 'COUNTIFS',
  args: Expr[],
  row: ParsedRow,
  ctx: EvaluationContext,
  report: EvalReport,
): EvaluationOutcome {
  if (!ctx.allRows) {
    // No row set wired in — aggregation can't run. Treat as the non-blocking
    // "rule did not apply" path so the rule keeps its place.
    report.typeMismatch = true;
    return NOT_APPLIED;
  }

  // Resolve every (column, criterionValue) pair. The parser already
  // guarantees args[0], args[2], ... are 'column' nodes.
  const pairs: { colField: string; critValue: FormulaValue }[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const colExpr = args[i];
    if (colExpr.type !== 'column') {
      // Defensive — parser blocks this, but keep the path safe.
      report.typeMismatch = true;
      return NOT_APPLIED;
    }
    const original = ctx.columnIndex.get(colExpr.name.toLowerCase());
    if (original === undefined) {
      if (!report.missingColumn) {
        report.missingColumn = true;
        report.missingColumnName = colExpr.name;
      }
      return NOT_APPLIED;
    }
    const critValue = evalExpr(args[i + 1], row, ctx, report);
    if (critValue === NOT_APPLIED) return NOT_APPLIED;
    pairs.push({ colField: original, critValue });
  }

  // Cache key: function-name + every (col, serialized-criterion) pair.
  const cacheKey = `${fnName}\0${pairs
    .map((p) => `${p.colField}\0${serializeForKey(p.critValue)}`)
    .join('\0')}`;
  const cached = ctx.countCache?.get(cacheKey);
  if (cached !== undefined) return cached;

  const compiled = pairs.map((p) => ({
    colField: p.colField,
    crit: parseCriterion(p.critValue),
  }));

  let count = 0;
  for (const otherRow of ctx.allRows) {
    let allMatch = true;
    for (const { colField, crit } of compiled) {
      const v = otherRow[colField] as FormulaValue;
      if (!matchesCriterion(v, crit)) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) count++;
  }
  ctx.countCache?.set(cacheKey, count);
  return count;
}

function serializeForKey(v: FormulaValue): string {
  if (v === null) return 'N';
  if (typeof v === 'number') return 'n:' + v;
  if (typeof v === 'string') return 's:' + v;
  if (typeof v === 'boolean') return 'b:' + (v ? '1' : '0');
  if (v instanceof Date) return 'd:' + v.getTime();
  return 'x:' + String(v);
}

// Parse an evaluated criterion value into a matcher. Resolution order:
//   1. Non-string criterion -> equality
//   2. String starts with >= / <= / <> / > / < / = -> operator+operand mode
//   3. Scan for unescaped wildcards (* ? % _) -> pattern (regex) mode
//   4. Otherwise -> equality on the processed literal
//
// Escape character is '\'. Inside a criterion string:
//   \* \? \% \_   -> literal wildcard character
//   \\            -> literal backslash
//   \X (other)    -> the backslash stays verbatim (forgiving)
//
// Escapes apply ONLY in the value / pattern branch — operator-mode operand
// is taken as-is (no wildcards in operator mode anyway).
function parseCriterion(rawValue: FormulaValue): Criterion {
  if (typeof rawValue !== 'string') {
    return { mode: 'value', value: rawValue };
  }
  // Operator prefix?
  let op: '>' | '<' | '>=' | '<=' | '<>' | '=' | null = null;
  let operandStr: string | null = null;
  if (rawValue.startsWith('>=')) { op = '>='; operandStr = rawValue.slice(2); }
  else if (rawValue.startsWith('<=')) { op = '<='; operandStr = rawValue.slice(2); }
  else if (rawValue.startsWith('<>')) { op = '<>'; operandStr = rawValue.slice(2); }
  else if (rawValue.startsWith('>')) { op = '>'; operandStr = rawValue.slice(1); }
  else if (rawValue.startsWith('<')) { op = '<'; operandStr = rawValue.slice(1); }
  else if (rawValue.startsWith('=')) { op = '='; operandStr = rawValue.slice(1); }

  if (op !== null && operandStr !== null) {
    // `=` / `<>` combine with text wildcards for Sheets/Excel parity (FORM-5):
    // a wildcard operand becomes a (possibly negated) pattern match. The
    // ordered operators (>, <, >=, <=) keep a literal operand — wildcards are
    // meaningless for an ordered comparison.
    if (op === '=' || op === '<>') {
      const compiled = compileWildcard(operandStr);
      if (compiled.hasWildcard) {
        return { mode: 'pattern', tokens: compiled.tokens, negate: op === '<>' };
      }
      // No active wildcard: equality on the (escape-resolved) operand, with
      // number / date coercion preserved.
      return { mode: 'op', op, operand: coerceCriterionOperand(compiled.literal) };
    }
    return { mode: 'op', op, operand: coerceCriterionOperand(operandStr) };
  }

  const { tokens, literal, hasWildcard } = compileWildcard(rawValue);
  if (hasWildcard) {
    return { mode: 'pattern', tokens, negate: false };
  }
  return { mode: 'value', value: literal };
}

// Compile a criterion string into wildcard tokens (for the linear matcher) plus
// its literal form, noting whether any active wildcard was present. Escapes
// (\* \? \% \_ \\) resolve to the literal character. Shared by the no-operator
// branch and the =/<> operator branches.
function compileWildcard(raw: string): { tokens: WildToken[]; literal: string; hasWildcard: boolean } {
  const tokens: WildToken[] = [];
  const pushStar = () => {
    // Collapse consecutive stars: `***` matches exactly what `*` does, and a
    // single star keeps the matcher trivially fast on the old pathological
    // inputs (FORM-1).
    const last = tokens[tokens.length - 1];
    if (!last || last.kind !== 'star') tokens.push({ kind: 'star' });
  };
  let literal = '';
  let hasWildcard = false;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === '*' || next === '?' || next === '%' || next === '_' || next === '\\') {
        tokens.push({ kind: 'lit', ch: next });
        literal += next;
        i += 2;
        continue;
      }
      // Unknown escape: keep the backslash verbatim and fall through.
    }
    if (c === '*' || c === '%') {
      pushStar();
      literal += c;
      hasWildcard = true;
      i++;
      continue;
    }
    if (c === '?' || c === '_') {
      tokens.push({ kind: 'any' });
      literal += c;
      hasWildcard = true;
      i++;
      continue;
    }
    tokens.push({ kind: 'lit', ch: c });
    literal += c;
    i++;
  }
  return { tokens, literal, hasWildcard };
}

// Linear, non-backtracking wildcard matcher (the classic two-pointer LIKE/glob
// algorithm). Matches the WHOLE string against the token list:
//   'lit'  -> that exact character
//   'any'  -> exactly one character (?, _)
//   'star' -> zero or more characters (*, %), greedy with a single backtrack
//             pointer to the most recent star
// Worst case O(text.length * tokens.length); it can NEVER catastrophically
// backtrack the way the old `.*.*…` regex could (FORM-1). Note: unlike the
// old regex's `.`, 'any'/'star' also match newlines here — arguably more
// correct (SQL LIKE '%' spans newlines too), and a non-issue for the
// single-line cell values these criteria target in practice.
function wildcardMatch(text: string, tokens: WildToken[]): boolean {
  let s = 0;       // index into text
  let p = 0;       // index into tokens
  let starP = -1;  // token index of the most recent star (-1 = none yet)
  let starS = 0;   // text index captured when that star was taken
  while (s < text.length) {
    const tok = tokens[p];
    if (tok && (tok.kind === 'any' || (tok.kind === 'lit' && tok.ch === text[s]))) {
      s++;
      p++;
    } else if (tok && tok.kind === 'star') {
      starP = p;
      starS = s;
      p++; // tentatively let the star match zero characters
    } else if (starP !== -1) {
      // Mismatch but we have a star to fall back on: let it absorb one more
      // character and retry from just after it.
      p = starP + 1;
      starS++;
      s = starS;
    } else {
      return false;
    }
  }
  // Any leftover tokens must all be stars to match the empty remainder.
  while (p < tokens.length && tokens[p].kind === 'star') p++;
  return p === tokens.length;
}

function coerceCriterionOperand(s: string): FormulaValue {
  // Number (int or float, with optional exponent)
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  if (/^-?\d+\.\d+(?:[eE][+-]?\d+)?$/.test(s) || /^-?\d+(?:[eE][+-]?\d+)$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  // ISO date (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)
  const d = parseIsoDate(s);
  if (d) return d;
  // Otherwise string
  return s;
}

function matchesCriterion(rowValue: FormulaValue | undefined, crit: Criterion): boolean {
  // NULL never matches anything (incl. NULL) — same rule as the '=' operator.
  if (rowValue === null || rowValue === undefined) return false;

  if (crit.mode === 'value') {
    return looseEquals(rowValue as FormulaValue, crit.value) === true;
  }

  if (crit.mode === 'pattern') {
    if (typeof rowValue !== 'string') {
      // A non-string value can't match a text pattern. For a negated (`<>`)
      // pattern that means "satisfied" — consistent with `<>` on a type
      // mismatch counting as not-equal.
      return crit.negate;
    }
    const m = wildcardMatch(rowValue, crit.tokens);
    return crit.negate ? !m : m;
  }

  // op mode
  if (crit.op === '=') {
    return looseEquals(rowValue as FormulaValue, crit.operand) === true;
  }
  if (crit.op === '<>') {
    const eq = looseEquals(rowValue as FormulaValue, crit.operand);
    // Mismatched types -> not equal (consistent with the '<>' operator path).
    return eq === null ? true : !eq;
  }

  // Ordered comparison. Reuse the date-string auto-coercion from evalBinary
  // so '">2026-01-01"' against a Date column works.
  let l: FormulaValue = rowValue as FormulaValue;
  let r: FormulaValue = crit.operand;
  if (l instanceof Date && typeof r === 'string') {
    const d = parseIsoDate(r);
    if (d) r = d;
  } else if (r instanceof Date && typeof l === 'string') {
    const d = parseIsoDate(l);
    if (d) l = d;
  }
  const cmp = orderedCompare(l, r);
  if (cmp === null) return false;
  if (crit.op === '>') return cmp > 0;
  if (crit.op === '>=') return cmp >= 0;
  if (crit.op === '<') return cmp < 0;
  if (crit.op === '<=') return cmp <= 0;
  return false;
}
