// Auto-wrap helper for the timestamp-fidelity patch.
//
// `bq --format=json` drops microseconds and the ` UTC` suffix from TIMESTAMP
// (and the analogous precision from DATETIME / TIME) when serialising query
// output. Confirmed empirically against every output format bq exposes; no
// flag controls this. The BQ web console doesn't have the issue because it
// hits the REST API directly and formats timestamps itself.
//
// Workaround: rewrite the user's SQL behind the scenes to wrap each temporal
// column in the appropriate FORMAT_* function. BigQuery returns the value as
// a STRING with full precision, which we then display verbatim. The original
// dry-run schema (still reporting TIMESTAMP / DATETIME / TIME) drives the
// column type so filters and conditional-formatting formulas treat the
// columns as temporal even though the wire-level shape is now string.
//
// Supported shapes:
//   * Top-level TIMESTAMP / DATETIME / TIME (single SELECT or WITH query).
//   * REPEATED (ARRAY<TIMESTAMP>) — wrapped via UNNEST + per-element FORMAT_*.
//   * Nested STRUCT containing temporal fields — rebuilt with STRUCT(...).
//   * ARRAY<STRUCT<...temporal...>> — UNNEST + rebuild STRUCT per element.
//   * Multi-statement scripts where each output-producing statement is an
//     independent SELECT / WITH (no shared variable state). Each one is
//     dry-run + wrapped independently and reassembled with `;`.
//
// Unsupported (passes through unwrapped, microseconds will be truncated):
//   * Scripts with control flow (DECLARE / SET / IF / WHILE / BEGIN/END).
//   * Mixed scripts where any statement isn't a standalone SELECT.
//   * DDL / DML — passed through anyway (no result grid).
//   * Timestamps stored inside JSON cell values (opaque to BQ's type system).

import type { SchemaField } from './dryRun';

export interface RewriteOutcome {
  // The rewritten SQL to send to bq, or null when we decided to pass
  // through (multi-statement that we couldn't rewrite, DDL/DML, no
  // temporal columns, schema empty, SQL too unusual to wrap safely).
  rewritten: string | null;
  // Names of the top-level columns that were wrapped. Used for diagnostics;
  // empty when rewritten is null.
  wrappedFields: string[];
}

const TEMPORAL_TYPES = new Set(['TIMESTAMP', 'DATETIME', 'TIME']);
const STRUCT_TYPES = new Set(['RECORD', 'STRUCT']);

// BigQuery auto-generates names like `f0_`, `f1_`, etc. for anonymous
// columns in a SELECT (e.g. `SELECT "literal"` with no alias). Those names
// are display labels — they can't be referenced by name in an outer
// SELECT. If a temporal-containing column has such a name, we abort the
// rewrite and pass the SQL through; otherwise our outer SELECT would
// generate invalid SQL referencing an unaddressable column.
const ANONYMOUS_NAME_RE = /^_?f\d+_?$/;

// ============================================================================
// Public entry point: single-statement rewrite.
// ============================================================================

/**
 * Rewrite a single SELECT/WITH statement so every temporal column (including
 * nested ones) is wrapped in FORMAT_*, returning microsecond-precision
 * strings to bq's JSON output.
 *
 * Returns { rewritten: null } when the SQL isn't a single SELECT/WITH, when
 * the schema is empty, or when there are no temporal columns to wrap.
 */
export function maybeRewriteForTemporalFidelity(
  sql: string,
  schema: SchemaField[] | undefined,
): RewriteOutcome {
  const empty: RewriteOutcome = { rewritten: null, wrappedFields: [] };

  if (!schema || schema.length === 0) return empty;

  const stripped = sql.trim().replace(/;\s*$/, '');
  if (!stripped) return empty;

  // Single-statement gate. The robust splitter respects string literals,
  // line comments, block comments, backtick identifiers, and BEGIN/END
  // depth — so the count is real.
  const pieces = splitStatements(stripped);
  if (pieces.length !== 1) return empty;
  const singleStmt = pieces[0];

  // Must look like SELECT or WITH at the very start (after comments + ws).
  const head = stripLeadingComments(singleStmt);
  if (!/^\s*(SELECT|WITH)\b/i.test(head)) return empty;

  if (!schemaHasTemporal(schema)) return empty;
  if (hasAnonymousTemporalField(schema)) return empty;

  const rewritten = buildSelectStarReplaceWrap(singleStmt, schema);
  const wrappedFields = schema
    .filter((f) => fieldContainsTemporal(f))
    .map((f) => f.name);
  return { rewritten, wrappedFields };
}

// ============================================================================
// Multi-statement rewrite.
// ============================================================================

export interface PerStatementSchema {
  // Index into the split statements (0-based).
  index: number;
  // The original statement text (no trailing `;`).
  sql: string;
  // Result of dry-running this statement standalone. null if not dry-run-able
  // (e.g. references a DECLARE from an earlier statement, or wasn't a SELECT).
  schema: SchemaField[] | null;
}

/**
 * Split a multi-statement script into individual statements. Used by the
 * caller to drive per-statement dry-runs. Returns the raw statement strings
 * (no trailing `;`), or a single-element array containing the original SQL
 * when only one statement is present.
 */
export function splitStatementsForScript(sql: string): string[] {
  return splitStatements(sql.trim().replace(/;\s*$/, ''));
}

/**
 * Rewrite a multi-statement script for temporal fidelity. Two strategies,
 * tried in order:
 *
 * 1. **Per-statement rewrite (preferred).** Every statement has a
 *    standalone dry-run schema (passed in via `perStatement[i].schema`).
 *    Each SELECT/WITH gets its own CTE wrap; non-SELECTs (DDL, DML) cause
 *    the whole thing to bail. Used for "three independent SELECTs"
 *    style scripts.
 *
 * 2. **Last-statement-only rewrite (fallback).** If any per-statement
 *    schema is null (e.g. a SELECT depends on a `DECLARE`d variable and
 *    can't dry-run in isolation), we instead try to use the script-level
 *    dry-run's schema — which BigQuery reports for the FINAL
 *    output-producing statement of the script. We rewrite only that last
 *    statement; the prelude (`DECLARE`, `SET`, earlier `SELECT`s, etc.) is
 *    passed through verbatim. Earlier SELECTs in the script lose
 *    microsecond precision under this fallback — a documented limitation.
 *
 * Returns `{ rewritten: null }` when neither strategy applies (no temporal
 * columns anywhere, or the last statement isn't a SELECT/WITH).
 */
export function maybeRewriteScriptForTemporalFidelity(
  perStatement: PerStatementSchema[],
  scriptLevelSchema?: SchemaField[],
): RewriteOutcome {
  const empty: RewriteOutcome = { rewritten: null, wrappedFields: [] };
  if (perStatement.length === 0) return empty;

  // Strategy 1: per-statement rewrite. Walk the script, wrap each
  // SELECT/WITH that has a schema with temporal columns, pass everything
  // else through verbatim (DECLARE, SET, DDL, DML, IF/WHILE blocks, and
  // SELECTs that we couldn't get a schema for). Non-SELECT statements are
  // preserved IN PLACE so script state (DECLAREd variables, SET values,
  // temp tables) is intact when subsequent SELECTs run.
  const wrappedFieldsFromStrategy1: string[] = [];
  const partsFromStrategy1: string[] = [];
  let anyRewriteFromStrategy1 = false;
  let strategy1Aborted = false;

  for (const stmt of perStatement) {
    const isSelect = /^\s*(SELECT|WITH)\b/i.test(stripLeadingComments(stmt.sql));
    if (!isSelect) {
      // DECLARE / SET / DDL / DML / control flow — pass through. We don't
      // wrap these because (a) we have no result grid for them and
      // (b) wrapping would change semantics (e.g. INSERT into a TIMESTAMP
      // column with a STRING value would corrupt the destination).
      partsFromStrategy1.push(stmt.sql);
      continue;
    }
    if (stmt.schema === null) {
      // SELECT we couldn't get a schema for. Fall back to strategy 2 (the
      // script-level schema covers the final SELECT only); abort strategy 1.
      strategy1Aborted = true;
      break;
    }
    const schema = stmt.schema;
    if (!schemaHasTemporal(schema)) {
      partsFromStrategy1.push(stmt.sql);
      continue;
    }
    if (hasAnonymousTemporalField(schema)) {
      // Can't safely reference auto-generated column names in an outer
      // SELECT — pass this statement through unwrapped, keep wrapping the
      // rest.
      partsFromStrategy1.push(stmt.sql);
      continue;
    }
    anyRewriteFromStrategy1 = true;
    for (const f of schema) {
      if (fieldContainsTemporal(f)) wrappedFieldsFromStrategy1.push(f.name);
    }
    partsFromStrategy1.push(buildSelectStarReplaceWrap(stmt.sql, schema));
  }

  if (!strategy1Aborted && anyRewriteFromStrategy1) {
    return {
      rewritten: partsFromStrategy1.join(';\n') + ';',
      wrappedFields: wrappedFieldsFromStrategy1,
    };
  }

  // Strategy 2 (fallback): rewrite only the final statement using the
  // script-level dry-run's schema. Catches cases where strategy 1 failed
  // because at least one SELECT couldn't be dry-run via the prefix path
  // (rare — typically partial-script syntax that requires later statements
  // to be valid, e.g. forward references in some BEGIN/END blocks).
  if (!scriptLevelSchema || scriptLevelSchema.length === 0) return empty;
  if (!schemaHasTemporal(scriptLevelSchema)) return empty;
  if (hasAnonymousTemporalField(scriptLevelSchema)) return empty;

  const lastIdx = perStatement.length - 1;
  const lastStmt = perStatement[lastIdx];
  const lastHead = stripLeadingComments(lastStmt.sql);
  if (!/^\s*(SELECT|WITH)\b/i.test(lastHead)) return empty;

  const wrappedFieldsLast: string[] = [];
  for (const f of scriptLevelSchema) {
    if (fieldContainsTemporal(f)) wrappedFieldsLast.push(f.name);
  }
  const wrappedLast = buildSelectStarReplaceWrap(lastStmt.sql, scriptLevelSchema);
  const before = perStatement.slice(0, lastIdx).map((s) => s.sql).join(';\n');
  const rewritten = before ? `${before};\n${wrappedLast};` : `${wrappedLast};`;
  return { rewritten, wrappedFields: wrappedFieldsLast };
}

// ============================================================================
// Schema-driven recursive wrap construction.
// ============================================================================

function schemaHasTemporal(fields: SchemaField[]): boolean {
  return fields.some(fieldContainsTemporal);
}

function fieldContainsTemporal(field: SchemaField): boolean {
  const t = (field.type ?? '').toUpperCase();
  if (TEMPORAL_TYPES.has(t)) return true;
  if (STRUCT_TYPES.has(t) && field.fields) {
    return field.fields.some(fieldContainsTemporal);
  }
  return false;
}

// True iff the schema has a temporal-containing column whose name is one
// of BigQuery's auto-generated anonymous labels (`f0_`, `_f0_`, etc.) —
// those can't be referenced in an outer SELECT, so we must abort the
// rewrite if such a column would need wrapping. Anonymous non-temporal
// columns are fine because `SELECT * REPLACE (...)` passes them through
// without naming.
function hasAnonymousTemporalField(fields: SchemaField[]): boolean {
  for (const f of fields) {
    if (!fieldContainsTemporal(f)) continue;
    if (ANONYMOUS_NAME_RE.test(f.name)) return true;
    if (f.fields && hasAnonymousTemporalField(f.fields)) return true;
  }
  return false;
}

// Build a `SELECT * REPLACE (...)` wrap around the user's SQL. Only
// temporal-containing columns appear in the REPLACE clause; every other
// column (including anonymous ones the user didn't bother aliasing)
// flows through `*` untouched. This is far more robust than listing
// every column by name — anonymous columns with auto-generated `f0_`
// names can't be referenced in an outer SELECT, and explicit lists also
// require us to perfectly mirror BigQuery's name-mangling for special
// characters. REPLACE keeps each replaced column in its original
// position so the user's SELECT order is preserved.
function buildSelectStarReplaceWrap(userSql: string, schema: SchemaField[]): string {
  const replaceItems: string[] = [];
  for (const f of schema) {
    if (!fieldContainsTemporal(f)) continue;
    const quoted = '`' + f.name + '`';
    replaceItems.push(`${wrapFieldExpression(f, quoted)} AS ${quoted}`);
  }
  return (
    `WITH __bqvs_temporal_fidelity AS (\n${userSql}\n)\n` +
    `SELECT * REPLACE (\n  ${replaceItems.join(',\n  ')}\n) FROM __bqvs_temporal_fidelity`
  );
}

// Wrap a field reference (e.g. `col`, `s.field`, or an UNNEST alias like `_e`)
// according to the schema field's type. The caller passes in the access path
// for this field; we apply FORMAT_* / STRUCT(...) / ARRAY(SELECT ...) as
// appropriate based on type and mode.
function wrapFieldExpression(field: SchemaField, accessPath: string): string {
  const mode = (field.mode ?? '').toUpperCase();
  if (mode === 'REPEATED') return wrapRepeated(field, accessPath);
  return wrapScalar(field, accessPath);
}

// Scalar (non-repeated) wrap. Recurses into structs.
function wrapScalar(field: SchemaField, accessPath: string): string {
  const t = (field.type ?? '').toUpperCase();
  if (t === 'TIMESTAMP') return `FORMAT_TIMESTAMP('%F %H:%M:%E*S UTC', ${accessPath})`;
  if (t === 'DATETIME') return `FORMAT_DATETIME('%FT%H:%M:%E*S', ${accessPath})`;
  if (t === 'TIME') return `FORMAT_TIME('%H:%M:%E*S', ${accessPath})`;
  if (STRUCT_TYPES.has(t) && field.fields) {
    // Only rebuild the struct if it contains a temporal field — saves SQL
    // bloat for unrelated nested structs.
    if (!field.fields.some(fieldContainsTemporal)) return accessPath;
    return buildStructExpression(field.fields, accessPath);
  }
  return accessPath;
}

// REPEATED wrap: ARRAY(SELECT <wrap of element> FROM UNNEST(<accessPath>) AS _e).
// The schema field describes the ELEMENT type (e.g. TIMESTAMP for ARRAY<TS>;
// RECORD with fields[] for ARRAY<STRUCT<...>>), so we wrap the element type.
function wrapRepeated(field: SchemaField, accessPath: string): string {
  const t = (field.type ?? '').toUpperCase();
  const elementAlias = '_e';
  let inner: string;
  if (t === 'TIMESTAMP') {
    inner = `FORMAT_TIMESTAMP('%F %H:%M:%E*S UTC', ${elementAlias})`;
  } else if (t === 'DATETIME') {
    inner = `FORMAT_DATETIME('%FT%H:%M:%E*S', ${elementAlias})`;
  } else if (t === 'TIME') {
    inner = `FORMAT_TIME('%H:%M:%E*S', ${elementAlias})`;
  } else if (STRUCT_TYPES.has(t) && field.fields) {
    if (!field.fields.some(fieldContainsTemporal)) {
      // Array of structs with no temporal anywhere — leave alone.
      return accessPath;
    }
    inner = buildStructExpression(field.fields, elementAlias);
  } else {
    // ARRAY of some other scalar — no temporal precision concern, leave alone.
    return accessPath;
  }
  return `ARRAY(SELECT ${inner} FROM UNNEST(${accessPath}) AS ${elementAlias})`;
}

// Build a STRUCT(...) literal that rebuilds a struct, wrapping each inner
// field if needed. accessPath is the base reference (e.g. `s` for a scalar
// struct column, or `_e` for an UNNEST element).
function buildStructExpression(fields: SchemaField[], accessPath: string): string {
  const parts = fields.map((f) => {
    const childPath = `${accessPath}.\`${f.name}\``;
    const expr = wrapFieldExpression(f, childPath);
    return `${expr} AS \`${f.name}\``;
  });
  return `STRUCT(${parts.join(', ')})`;
}

// ============================================================================
// Robust statement splitter.
// ============================================================================

/**
 * Split a script into top-level statements on `;`. Respects:
 *   * `--line comments` (skip to next newline)
 *   * `/* block comments *\/` (skip to closing token)
 *   * `'single-quoted'` and `"double-quoted"` string literals
 *     (with `''` and `""` escapes; also handles `\'` and `\"` for
 *     legacy-SQL compatibility)
 *   * Triple-quoted strings (`'''...'''` and `"""..."""`)
 *   * `` `backtick identifiers `` (no escape; bq doesn't allow embedded backticks)
 *   * `BEGIN ... END` block depth — `;` inside a BEGIN/END is not a split.
 *
 * Returns the list of statements with trailing/leading whitespace trimmed
 * and empty pieces dropped. Useful both for counting (single vs multi) and
 * for the multi-statement rewrite path.
 */
function splitStatements(sql: string): string[] {
  const result: string[] = [];
  let buf = '';
  let i = 0;
  let beginDepth = 0;
  const n = sql.length;

  const pushIfNotEmpty = (): void => {
    const t = buf.trim();
    if (t) result.push(t);
    buf = '';
  };

  // We need to detect BEGIN / END as keywords, so we track word boundaries
  // by checking whether we're at the start of an identifier-shaped token.
  // (A naive substring check would match the BEGIN inside BIGINT or a
  // column name, etc.)
  const matchWordHere = (word: string): boolean => {
    const end = i + word.length;
    if (end > n) return false;
    if (sql.slice(i, end).toUpperCase() !== word.toUpperCase()) return false;
    const before = i === 0 ? ' ' : sql[i - 1];
    const after = end >= n ? ' ' : sql[end];
    return !isIdentChar(before) && !isIdentChar(after);
  };

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    // Line comment
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') {
        buf += sql[i];
        i++;
      }
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      buf += '/*';
      i += 2;
      while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        buf += sql[i];
        i++;
      }
      if (i + 1 < n) {
        buf += '*/';
        i += 2;
      } else {
        // Unterminated block comment — bail and treat the rest as plain text.
        buf += sql.slice(i);
        i = n;
      }
      continue;
    }
    // Triple-quoted strings
    if (
      (ch === "'" || ch === '"') &&
      sql[i + 1] === ch &&
      sql[i + 2] === ch
    ) {
      const quote = ch;
      buf += quote + quote + quote;
      i += 3;
      while (i < n) {
        if (
          sql[i] === quote &&
          sql[i + 1] === quote &&
          sql[i + 2] === quote
        ) {
          buf += quote + quote + quote;
          i += 3;
          break;
        }
        // backslash escape inside string
        if (sql[i] === '\\' && i + 1 < n) {
          buf += sql[i] + sql[i + 1];
          i += 2;
          continue;
        }
        buf += sql[i];
        i++;
      }
      continue;
    }
    // Single-quoted / double-quoted strings
    if (ch === "'" || ch === '"') {
      const quote = ch;
      buf += quote;
      i++;
      while (i < n) {
        // Standard SQL doubled-quote escape
        if (sql[i] === quote && sql[i + 1] === quote) {
          buf += quote + quote;
          i += 2;
          continue;
        }
        // Backslash escape (legacy SQL / GoogleSQL string literal)
        if (sql[i] === '\\' && i + 1 < n) {
          buf += sql[i] + sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          buf += quote;
          i++;
          break;
        }
        if (sql[i] === '\n') {
          // Unterminated single-line string — treat newline as end-of-string
          // to avoid swallowing the rest of the script as one big literal.
          // (Triple-quoted strings are handled in their own branch above.)
          break;
        }
        buf += sql[i];
        i++;
      }
      continue;
    }
    // Backtick identifier
    if (ch === '`') {
      buf += '`';
      i++;
      while (i < n && sql[i] !== '`') {
        buf += sql[i];
        i++;
      }
      if (i < n) {
        buf += '`';
        i++;
      }
      continue;
    }
    // BEGIN/END depth tracking — only when we're at a word boundary so we
    // don't match identifiers like BEGINNING or COMMENT.
    if ((ch === 'B' || ch === 'b') && matchWordHere('BEGIN')) {
      beginDepth++;
      buf += sql.slice(i, i + 5);
      i += 5;
      continue;
    }
    if ((ch === 'E' || ch === 'e') && matchWordHere('END')) {
      // END followed by IF/LOOP/WHILE keeps the block — but each form is
      // still terminated by an unqualified END. We treat any END at depth>0
      // as decrementing depth (most accurate for the common BEGIN/END case).
      if (beginDepth > 0) beginDepth--;
      buf += sql.slice(i, i + 3);
      i += 3;
      continue;
    }
    // Statement separator
    if (ch === ';' && beginDepth === 0) {
      pushIfNotEmpty();
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  pushIfNotEmpty();
  return result;
}

function isIdentChar(c: string): boolean {
  if (!c) return false;
  return (
    (c >= 'A' && c <= 'Z') ||
    (c >= 'a' && c <= 'z') ||
    (c >= '0' && c <= '9') ||
    c === '_'
  );
}

// Skip leading whitespace, `-- line comments`, and `/* block comments */`
// so the SELECT/WITH detection sees the first non-comment token.
function stripLeadingComments(s: string): string {
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && s[i + 1] === '*') {
      i += 2;
      while (i + 1 < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    break;
  }
  return s.slice(i);
}
