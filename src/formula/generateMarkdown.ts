// Generates docs/formula-language.md from FUNCTIONS / OPERATORS / SYNTAX_NOTES
// in docs.ts. The function/operator tables flow from docs.ts so the
// markdown can never drift from the inline help panel or Monaco tooltips.
// The prose sections (intro, differences-from-Sheets/BQ, common patterns,
// behavior notes) live here in the generator — they're audience-specific
// commentary that doesn't belong in the data file.
//
// Run via: node scripts/gen-docs.js
// or import and call buildMarkdown() programmatically.

import { FUNCTIONS, OPERATORS, SYNTAX_NOTES } from './docs';

export function buildMarkdown(): string {
  const lines: string[] = [];

  lines.push('# Formula language reference');
  lines.push('');
  lines.push(
    'A short reference for the conditional-formatting formulas. Audience: people who already know SQL / BigQuery / Sheets and want the surface area at a glance — not a beginner tutorial.',
  );
  lines.push('');

  // -------- TL;DR --------------------------------------------------------
  lines.push('## TL;DR');
  lines.push('');
  lines.push(
    'Each rule is one expression evaluated per row. If it returns truthy, the rule paints the row in its color. Rules are ordered top-down; the first match wins. The language is Sheets/Excel-shaped with a small, deliberate function set — no row positions, no cell ranges, no UDFs.',
  );
  lines.push('');
  lines.push('Quick smell test:');
  lines.push('');
  lines.push('```');
  lines.push('AND(NOT(ISNULL(str_col)), num_col > 100)');
  lines.push('YEAR(date_col) = 2026 AND str_col <> "active"');
  lines.push('CONTAINS(LOWER(str_col), "text")');
  lines.push('```');
  lines.push('');
  lines.push(
    'If those parse on first read, you already know the language. Skim the rest for edge cases.',
  );
  lines.push('');

  // -------- Cheat sheet --------------------------------------------------
  lines.push('## At a glance');
  lines.push('');
  lines.push('| Concept | Form |');
  lines.push('| --- | --- |');
  lines.push('| Column ref | `num_col`, `` `my column` `` (backticks for spaces/specials; case-insensitive match) |');
  lines.push('| Numeric literal | `100`, `3.14`, `-5`, `1e3` |');
  lines.push('| String literal | `"hello"` or `\'hello\'` (both quote styles), doubled `""` / `\'\'` to escape |');
  lines.push('| Bool / null | `TRUE`, `FALSE`, `NULL` |');
  lines.push('| Compare | `=` `<>` `<` `<=` `>` `>=` |');
  lines.push('| Logic | `AND` `OR` `NOT` — also as functions: `AND(...)`, `OR(...)`, `NOT(x)` |');
  lines.push('| Math | `+` `-` `*` `/`, `MOD`, `ABS`, `ROUND` |');
  lines.push('| Text | `CONTAINS`, `LEN`, `LOWER`, `UPPER` |');
  lines.push('| Date | `YEAR`, `MONTH`, `DAY`, `TODAY()`, `DATE("YYYY-MM-DD")` |');
  lines.push('| Null check | `ISNULL(x)`, `ISBLANK(x)` |');
  lines.push('| Aggregate | `COUNTIF(col, criterion)`, `COUNTIFS(col1, c1, col2, c2, ...)` |');
  lines.push('');

  // -------- Differences from SQL / Sheets --------------------------------
  lines.push('## If you come from SQL / BigQuery');
  lines.push('');
  lines.push(
    '- **Column refs are case-insensitive.** `Num_Col`, `num_col`, `NUM_COL` all bind to the same column. Sheets convention, not BQ.',
  );
  lines.push(
    '- **String equality is strict.** No silent coercion — `"5" = 5` is `FALSE`, not `TRUE`. Compare like with like.',
  );
  lines.push(
    "- **NULL behaves like SQL's three-valued logic.** Any comparison with `NULL` is `NULL` (treated as falsy in rule context, so the rule doesn't match). Use `ISNULL(x)` to test explicitly.",
  );
  lines.push(
    "- **Both quote styles are strings, just like BigQuery.** `'foo'` and `\"foo\"` are both string literals. Doubled-quote inside a string escapes: `\"she said \"\"hi\"\"\"`.",
  );
  lines.push(
    '- **Backticks reference columns, just like BigQuery.** Column names with spaces or special characters go in backticks: `` `my column` ``. Bare identifiers (`num_col`) work without backticks. Quotes are never column references.',
  );
  lines.push(
    '- **Division by zero returns `NULL`** (not an error). `10 / 0 = something` is `NULL`, so the rule sits out the row.',
  );
  lines.push(
    '- **No `BETWEEN`, `IN`, `LIKE`.** Use `x >= a AND x <= b`, `x = "a" OR x = "b"`, or `CONTAINS(LOWER(x), "needle")`.',
  );
  lines.push(
    '- **No subqueries, no joins.** Each rule evaluates against a single row of the currently-displayed result — except for `COUNTIF` / `COUNTIFS`, which aggregate across all rows in the current result (see below).',
  );
  lines.push('');

  lines.push('## If you come from Sheets / Excel');
  lines.push('');
  lines.push(
    '- **No `$A2`, no `ROW()`, no `A1:A10`.** BQ results have no inherent row position and no column letters; everything is by column name.',
  );
  lines.push(
    '- **`AND` / `OR` / `NOT` work as both infix operators and functions.** `x > 0 AND y > 0` and `AND(x > 0, y > 0)` are identical. Pick whichever reads better.',
  );
  lines.push(
    '- **No conditional ranges.** Sheets-style `SUMIF` / `COUNTIF` / `FILTER` over a range have no analogue — a rule sees one row at a time.',
  );
  lines.push(
    '- **Date literals.** A `DATE` column compared to a string like `"2026-05-20"` auto-coerces the string via `DATE()`. For ambiguous formats wrap explicitly: `date_col = DATE("2026-05-20")`.',
  );
  lines.push(
    "- **No format-specific functions.** No `TEXT()`, no `VALUE()`. The grid handles display formatting; rules see typed values.",
  );
  lines.push('');

  // -------- Syntax notes (from docs.ts) ---------------------------------
  lines.push('## Syntax notes');
  lines.push('');
  for (const s of SYNTAX_NOTES) {
    lines.push(`**${s.title}.** ${s.body}`);
    lines.push('');
  }

  // -------- Operators ----------------------------------------------------
  lines.push('## Operators');
  lines.push('');
  const opCats: Array<['arithmetic' | 'comparison' | 'logical', string]> = [
    ['arithmetic', 'Arithmetic'],
    ['comparison', 'Comparison'],
    ['logical', 'Logical'],
  ];
  for (const [cat, label] of opCats) {
    lines.push(`### ${label}`);
    lines.push('');
    lines.push('| Operator | Description | Example |');
    lines.push('| --- | --- | --- |');
    for (const op of OPERATORS.filter((o) => o.category === cat)) {
      lines.push(`| \`${op.symbol}\` | ${op.description} | \`${op.example}\` |`);
    }
    lines.push('');
  }
  lines.push(
    'Precedence (high → low): unary `-` / `NOT`, `*` `/`, `+` `-`, comparisons, `AND`, `OR`. Group with parentheses; chained comparisons (`a = b = c`) are a parse error — use `AND(a = b, b = c)`.',
  );
  lines.push('');

  // -------- Functions ----------------------------------------------------
  lines.push('## Functions');
  lines.push('');
  const fnCats: Array<['logical' | 'math' | 'text' | 'date' | 'null' | 'aggregate', string]> = [
    ['logical', 'Logical'],
    ['math', 'Math'],
    ['text', 'Text'],
    ['date', 'Date'],
    ['null', 'Null checks'],
    ['aggregate', 'Aggregations'],
  ];
  for (const [cat, label] of fnCats) {
    lines.push(`### ${label}`);
    lines.push('');
    for (const fn of FUNCTIONS.filter((f) => f.category === cat)) {
      lines.push(`#### \`${fn.signature}\``);
      lines.push('');
      lines.push(fn.description);
      lines.push('');
      lines.push(`**Example:** \`${fn.example}\``);
      lines.push('');
    }
  }

  // -------- Common patterns ---------------------------------------------
  lines.push('## Common patterns');
  lines.push('');
  lines.push('Practical formulas you can paste verbatim and adapt:');
  lines.push('');

  lines.push('### Null / blank checks');
  lines.push('```');
  lines.push('ISNULL(str_col)                            -- column is null');
  lines.push('NOT(ISNULL(str_col))                       -- column is set');
  lines.push('ISBLANK(str_col)                           -- null OR empty string');
  lines.push('```');
  lines.push('');

  lines.push('### Numeric thresholds');
  lines.push('```');
  lines.push('num_col > 100');
  lines.push('AND(num_col >= 60, num_col <= 300)         -- range (replaces BETWEEN)');
  lines.push('ABS(num_col) > 30                          -- threshold either direction');
  lines.push('ROUND(num_col, 2) <> num_col               -- more than 2 decimal places');
  lines.push('```');
  lines.push('');

  lines.push('### Even / odd / stripes');
  lines.push('```');
  lines.push('MOD(num_col, 2) = 0                        -- "every even-count row"');
  lines.push('MOD(num_col, 10) < 3                       -- "first 3 of every 10"');
  lines.push('```');
  lines.push('');

  lines.push('### String matching');
  lines.push('```');
  lines.push('CONTAINS(LOWER(str_col), "abc")            -- case-insensitive substring');
  lines.push('LEN(str_col) > 200                         -- "long values"');
  lines.push('UPPER(str_col) = "ACTIVE"                  -- normalize before compare');
  lines.push('OR(str_col = "active", str_col = "pending") -- multi-value match (no IN)');
  lines.push('```');
  lines.push('');

  lines.push('### Dates and time windows');
  lines.push('```');
  lines.push('YEAR(date_col) = 2026');
  lines.push('AND(YEAR(date_col) = 2026, MONTH(date_col) = 5) -- specific month');
  lines.push('date_col >= TODAY()                        -- today or future');
  lines.push('date_col = DATE("2026-05-20")              -- exact date match');
  lines.push('AND(date_col >= DATE("2026-01-01"), date_col < DATE("2026-02-01"))');
  lines.push('```');
  lines.push('');

  lines.push('### Compound logic');
  lines.push('```');
  lines.push('IF(num_col > 300, NOT(ISNULL(str_col)), FALSE)');
  lines.push('AND(NOT(ISNULL(str_col)), num_col > 100, str_col <> "active")');
  lines.push('OR(ISNULL(str_col), str_col = "unknown")');
  lines.push('```');
  lines.push('');

  lines.push('### Cross-row counts (COUNTIF / COUNTIFS)');
  lines.push('```');
  lines.push('COUNTIF(str_col, str_col) > 30           -- this value appears > 30 times');
  lines.push('COUNTIF(str_col, "active") > 0           -- any matching rows exist? (rule applies to all)');
  lines.push('COUNTIFS(str_col, str_col, num_col, ">100") > 5');
  lines.push('                                         -- > 5 rows share this str_col AND have num_col > 100');
  lines.push('COUNTIF(num_col, ">300") >= 3            -- there are 3+ rows above 300');
  lines.push('COUNTIF(str_col, "*text*") > 0           -- pattern: any row contains "text"');
  lines.push('```');
  lines.push('');
  lines.push(
    'The first argument must be a bare column reference. The second argument (the criterion) supports four forms — see the next section.',
  );
  lines.push('');

  // -------- COUNTIF criterion syntax ------------------------------------
  lines.push('## COUNTIF / COUNTIFS criterion syntax');
  lines.push('');
  lines.push(
    "`COUNTIF(col, criterion)` and `COUNTIFS(col1, c1, col2, c2, ...)` are the only aggregations in the language. Every other function sees one row at a time; these iterate the entire current result.",
  );
  lines.push('');
  lines.push("The first argument **must** be a column reference (e.g. `str_col` or `` `my column` ``). Expressions like `LOWER(str_col)` aren't accepted there — the language treats the column reference as the source range, not as an expression to evaluate per row.");
  lines.push('');
  lines.push("The criterion (second / fourth / sixth… argument) is evaluated against the *current* row, then matched against every row in the result. It can take one of four shapes:");
  lines.push('');

  lines.push('### 1. Direct value → equality');
  lines.push('```');
  lines.push('COUNTIF(str_col, str_col)       -- count rows whose str_col = this row\'s str_col');
  lines.push('COUNTIF(str_col, "active")      -- count rows whose str_col = "active" exactly');
  lines.push('COUNTIF(num_col, 100)           -- count rows whose num_col = 100');
  lines.push('```');
  lines.push('Type-strict — no coercion. `"5" = 5` does not match. NULL row values never count, even when matched against NULL.');
  lines.push('');

  lines.push('### 2. Operator-prefixed string → comparison');
  lines.push('A string that begins with `>=`, `<=`, `<>`, `>`, `<`, or `=` is parsed as `<operator><operand>`. The operand is interpreted as a number when it parses as one, an ISO date when it parses as one, otherwise as a string.');
  lines.push('');
  lines.push('```');
  lines.push('COUNTIF(num_col, ">100")             -- num_col > 100 (numeric)');
  lines.push('COUNTIF(num_col, ">=300")');
  lines.push('COUNTIF(str_col, "<>active")         -- str_col is not "active"');
  lines.push('COUNTIF(date_col, ">2026-01-01")     -- DATE column > 2026-01-01');
  lines.push('COUNTIF(str_col, "=active")          -- explicit equality (same as direct value)');
  lines.push('```');
  lines.push('No wildcards in this mode — `">active*"` means "greater than the literal string `active*`", which is rarely useful but well-defined.');
  lines.push('');

  lines.push('### 3. Wildcard string → pattern match');
  lines.push('A string containing `*`, `?`, `%`, or `_` is treated as a wildcard pattern. Sheets-style and SQL-style wildcards are interchangeable:');
  lines.push('');
  lines.push('| Wildcard | Means | SQL alias |');
  lines.push('| --- | --- | --- |');
  lines.push('| `*` | zero or more characters | `%` |');
  lines.push('| `?` | exactly one character | `_` |');
  lines.push('');
  lines.push('```');
  lines.push('COUNTIF(str_col, "abc*")             -- starts with "abc"');
  lines.push('COUNTIF(str_col, "abc%")             -- same, SQL form');
  lines.push('COUNTIF(str_col, "*text*")           -- contains "text"');
  lines.push('COUNTIF(str_col, "abc?123")          -- single-char wildcard');
  lines.push('```');
  lines.push("Wildcard matching is **case-sensitive**. The column-reference rule means you can't wrap the column in `LOWER(...)` to bypass it; if you need case-insensitive matching, normalize at SQL time or stick to direct-value equality with `LOWER()` applied at the SQL layer.");
  lines.push('');

  lines.push('### 4. Escape character `\\`');
  lines.push('Use `\\` inside a criterion string to make the next character literal. Active only for the wildcard characters and the backslash itself:');
  lines.push('');
  lines.push('| Sequence | Means |');
  lines.push('| --- | --- |');
  lines.push('| `\\*` | literal `*` |');
  lines.push('| `\\?` | literal `?` |');
  lines.push('| `\\%` | literal `%` |');
  lines.push('| `\\_` | literal `_` |');
  lines.push('| `\\\\` | literal `\\` |');
  lines.push('| `\\` + anything else | the `\\` stays verbatim (forgiving) |');
  lines.push('');
  lines.push('```');
  lines.push('COUNTIF(str_col, "abc\\*")           -- equals the literal string "abc*"');
  lines.push('COUNTIF(str_col, "*\\**")            -- pattern: contains a literal "*"');
  lines.push('COUNTIF(str_col, "100\\%")           -- equals the literal string "100%"');
  lines.push('COUNTIF(str_col, "\\\\path")         -- equals the literal string "\\path"');
  lines.push('```');
  lines.push('');
  lines.push('### What COUNTIF criteria can\'t express');
  lines.push('');
  lines.push("- **Strings that genuinely start with an operator character.** A criterion `\">30\"` is always parsed as a comparison; there's no escape for the operator prefix. If you need to count rows whose value equals the string `\">30\"`, use a plain `col = \">30\"` rule instead.");
  lines.push('- **Case-insensitive wildcards** without normalizing in SQL first (see above).');
  lines.push('- **Regex.** Use multiple `CONTAINS` / wildcard criteria combined with `OR` if you need more than one pattern.');
  lines.push('');

  // -------- Behavior notes ----------------------------------------------
  lines.push('## Behavior notes');
  lines.push('');
  lines.push(
    '- **Rule priority.** The list is evaluated top-down per row; the first match wins. Use the ▲ / ▼ buttons in the popover to reorder.',
  );
  lines.push(
    '- **Missing columns are non-blocking.** A formula that references a column not in the current result sits idle with a ⚠ in the rules list. Run a different query in the same file that does have the column and the rule starts matching again — no edit required.',
  );
  lines.push(
    "- **Type mismatches are non-blocking too.** Comparing a string column to a number literal (column type changed between queries, say) skips that row silently rather than failing the rule.",
  );
  lines.push(
    "- **Rules + click highlighting.** When a rule matches a row, the rule paints the data cells and a row click (color picker in the footer) paints only the row-number gutter as a small square. Rows without any matching rule behave like before — a click paints the whole row.",
  );
  lines.push(
    '- **Persistence.** Rules live in `workspaceState` keyed by the file URI. They survive VS Code restarts, follow `.sql` file renames, and are deep-copied to any file you duplicate in the workspace (matched by content hash). Closing a tab does not delete rules; deleting the file does.',
  );
  lines.push(
    '- **Per-statement.** Rules apply per-statement when drilled into a multi-statement script. Each statement has its own column set — a rule that references columns missing from one statement still works on another.',
  );
  lines.push('');

  // -------- Intentional omissions ---------------------------------------
  lines.push('## Intentional omissions');
  lines.push('');
  lines.push("Things SQL/Sheets users might reach for that this language doesn't have, on purpose:");
  lines.push('');
  lines.push('- Most aggregations (`SUM`, `AVG`, `MIN`, `MAX`). The only aggregations supported are `COUNTIF` and `COUNTIFS`.');
  lines.push('- Subqueries, joins, cross-row references.');
  lines.push('- Regex (`REGEXP_CONTAINS`, `RLIKE`). Use `CONTAINS` + `LOWER` / `UPPER` for substring matching.');
  lines.push('- User-defined functions.');
  lines.push('- Cell-range references (`A1:A10`), row indices, column letters.');
  lines.push('- Format / display functions (`TEXT`, `FORMAT_DATE`). Rules see typed values; display is the grid\'s job.');
  lines.push('- `BETWEEN`, `IN`, `LIKE`. Express via combinations of the supported operators (see Common patterns).');
  lines.push('- Hide / show actions on rules — rules color rows only, never hide them.');
  lines.push('');

  return lines.join('\n') + '\n';
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');
  const out = path.join(__dirname, '..', '..', 'docs', 'formula-language.md');
  fs.writeFileSync(out, buildMarkdown(), 'utf8');
  // eslint-disable-next-line no-console
  console.log(`Wrote ${out}`);
}
