# Formula language reference

A short reference for the conditional-formatting formulas. Audience: people who already know SQL / BigQuery / Sheets and want the surface area at a glance — not a beginner tutorial.

## TL;DR

Each rule is one expression evaluated per row. If it returns truthy, the rule paints the row in its color. Rules are ordered top-down; the first match wins. The language is Sheets/Excel-shaped with a small, deliberate function set — no row positions, no cell ranges, no UDFs.

Quick smell test:

```
AND(NOT(ISNULL(str_col)), num_col > 100)
YEAR(date_col) = 2026 AND str_col <> "active"
CONTAINS(LOWER(str_col), "text")
```

If those parse on first read, you already know the language. Skim the rest for edge cases.

## At a glance

| Concept | Form |
| --- | --- |
| Column ref | `num_col`, `` `my column` `` (backticks for spaces/specials; case-insensitive match) |
| Numeric literal | `100`, `3.14`, `-5`, `1e3` |
| String literal | `"hello"` or `'hello'` (both quote styles), doubled `""` / `''` to escape |
| Bool / null | `TRUE`, `FALSE`, `NULL` |
| Compare | `=` `<>` `<` `<=` `>` `>=` |
| Logic | `AND` `OR` `NOT` — also as functions: `AND(...)`, `OR(...)`, `NOT(x)` |
| Math | `+` `-` `*` `/`, `MOD`, `ABS`, `ROUND` |
| Text | `CONTAINS`, `LEN`, `LOWER`, `UPPER` |
| Date | `YEAR`, `MONTH`, `DAY`, `TODAY()`, `DATE("YYYY-MM-DD")` |
| Null check | `ISNULL(x)`, `ISBLANK(x)` |
| Aggregate | `COUNTIF(col, criterion)`, `COUNTIFS(col1, c1, col2, c2, ...)` |

## If you come from SQL / BigQuery

- **Column refs are case-insensitive.** `Num_Col`, `num_col`, `NUM_COL` all bind to the same column. Sheets convention, not BQ.
- **String equality is strict.** No silent coercion — `"5" = 5` is `FALSE`, not `TRUE`. Compare like with like.
- **NULL behaves like SQL's three-valued logic.** Any comparison with `NULL` is `NULL` (treated as falsy in rule context, so the rule doesn't match). Use `ISNULL(x)` to test explicitly.
- **Both quote styles are strings, just like BigQuery.** `'foo'` and `"foo"` are both string literals. Doubled-quote inside a string escapes: `"she said ""hi"""`.
- **Backticks reference columns, just like BigQuery.** Column names with spaces or special characters go in backticks: `` `my column` ``. Bare identifiers (`num_col`) work without backticks. Quotes are never column references.
- **Division by zero returns `NULL`** (not an error). `10 / 0 = something` is `NULL`, so the rule sits out the row.
- **No `BETWEEN`, `IN`, `LIKE`.** Use `x >= a AND x <= b`, `x = "a" OR x = "b"`, or `CONTAINS(LOWER(x), "needle")`.
- **No subqueries, no joins.** Each rule evaluates against a single row of the currently-displayed result — except for `COUNTIF` / `COUNTIFS`, which aggregate across all rows in the current result (see below).

## If you come from Sheets / Excel

- **No `$A2`, no `ROW()`, no `A1:A10`.** BQ results have no inherent row position and no column letters; everything is by column name.
- **`AND` / `OR` / `NOT` work as both infix operators and functions.** `x > 0 AND y > 0` and `AND(x > 0, y > 0)` are identical. Pick whichever reads better.
- **No conditional ranges.** Sheets-style `SUMIF` / `COUNTIF` / `FILTER` over a range have no analogue — a rule sees one row at a time.
- **Date literals.** A `DATE` column compared to a string like `"2026-05-20"` auto-coerces the string via `DATE()`. For ambiguous formats wrap explicitly: `date_col = DATE("2026-05-20")`.
- **No format-specific functions.** No `TEXT()`, no `VALUE()`. The grid handles display formatting; rules see typed values.

## Syntax notes

**Column references.** Reference columns by name. Bare identifiers like `num_col` are fine; columns with spaces or special characters use backticks — the same way you quote them in BigQuery SQL: `` `my column` ``. Column matching is case-insensitive. (Quotes — `"..."` or `'...'` — are always string literals, never column references.)

**Literals.** Numbers (`100`, `3.14`, `-5`), strings in either double or single quotes (`"hello"`, `'hello'` — both work, as in BigQuery), booleans `TRUE` / `FALSE`, and `NULL`. A doubled quote escapes a literal quote inside a string (`"she said ""hi"""`).

**NULL handling.** Any comparison with NULL evaluates to NULL, which is treated as falsy in rule context (rule does not match). Use `ISNULL(x)` or `ISBLANK(x)` to test explicitly.

**Type comparisons.** Comparisons between different types (e.g. number vs string) evaluate as not-equal — there is no silent coercion. Temporal cells (DATE / DATETIME / TIMESTAMP / TIME) are stored as the raw BigQuery string and auto-coerced when compared against a DATE("...") literal — the language accepts every shape BQ emits, including timestamps with microseconds and ` UTC` suffix.

## Operators

### Arithmetic

| Operator | Description | Example |
| --- | --- | --- |
| `+` | Addition. | `col_a + col_b > 200` |
| `-` | Subtraction (or unary negation). | `col_a - col_b > 60` |
| `*` | Multiplication. | `col_a * col_b > 1000` |
| `/` | Division. Division by zero returns NULL. | `col_a / col_b > 50` |

### Comparison

| Operator | Description | Example |
| --- | --- | --- |
| `=` | Equality. Different types compare as not-equal. | `str_col = "active"` |
| `<>` | Inequality. | `str_col <> "active"` |
| `<` | Less than. | `num_col < 30` |
| `<=` | Less than or equal. | `num_col <= 30` |
| `>` | Greater than. | `num_col > 100` |
| `>=` | Greater than or equal. | `num_col >= 100` |

### Logical

| Operator | Description | Example |
| --- | --- | --- |
| `AND` | Infix logical AND (also available as AND() function). | `col_a > 0 AND col_b > 0` |
| `OR` | Infix logical OR. | `col_a = 1 OR col_a = 2` |
| `NOT` | Prefix logical NOT (also available as NOT() function). | `NOT ISNULL(col_a)` |

Precedence (high → low): unary `-` / `NOT`, `*` `/`, `+` `-`, comparisons, `AND`, `OR`. Group with parentheses; chained comparisons (`a = b = c`) are a parse error — use `AND(a = b, b = c)`.

## Functions

### Logical

#### `IF(condition, value_if_true, value_if_false)`

Returns the second argument when the condition is truthy, otherwise the third. NULL conditions are treated as falsy.

**Example:** `IF(num_col > 100, "high", "low")`

#### `AND(cond1, cond2, ...)`

TRUE when every argument is truthy. NULL arguments are treated as falsy. Also available as an infix operator.

**Example:** `AND(num_col > 100, NOT(ISNULL(str_col)))`

#### `OR(cond1, cond2, ...)`

TRUE when at least one argument is truthy. Also available as an infix operator.

**Example:** `OR(num_col > 100, str_col = "active")`

#### `NOT(value)`

Inverts the truthiness of the argument. NOT(NULL) is NULL (treated as falsy in rule context).

**Example:** `NOT(ISNULL(str_col))`

### Math

#### `MOD(a, b)`

Returns the remainder of a divided by b. Both arguments must be numbers; division by zero returns NULL.

**Example:** `MOD(num_col, 2) = 0`

#### `ABS(n)`

Returns the absolute value of a number.

**Example:** `ABS(num_col) > 100`

#### `ROUND(n, digits)`

Rounds n to the given number of decimal digits. Negative digits round to tens/hundreds.

**Example:** `ROUND(num_col, 2) > 5.25`

### Text

#### `CONTAINS(text, substring)`

Returns TRUE when `text` contains `substring` as a substring. Case-sensitive.

**Example:** `CONTAINS(str_col, "text")`

#### `LEN(text)`

Returns the length of the string in characters.

**Example:** `LEN(str_col) > 10`

#### `LOWER(text)`

Returns the string lowercased.

**Example:** `LOWER(str_col) = "value"`

#### `UPPER(text)`

Returns the string uppercased.

**Example:** `UPPER(str_col) = "VALUE"`

### Date

#### `YEAR(date_or_timestamp)`

Returns the 4-digit year of a DATE / DATETIME / TIMESTAMP value. Temporal cells are stored as the raw BigQuery string (e.g. "2026-04-15 18:17:12.418000 UTC") and parsed on demand, anchored to UTC.

**Example:** `YEAR(date_col) = 2026`

#### `MONTH(date_or_timestamp)`

Returns the month (1-12) of a DATE / DATETIME / TIMESTAMP, anchored to UTC.

**Example:** `MONTH(date_col) = 1`

#### `DAY(date_or_timestamp)`

Returns the day of the month (1-31) of a DATE / DATETIME / TIMESTAMP, anchored to UTC.

**Example:** `DAY(date_col) > 15`

#### `TODAY()`

Returns today's date (DATE, no time component).

**Example:** `date_col >= TODAY()`

#### `DATE(iso_string)`

Parses a temporal string into a DATE value (anchored to UTC). Accepts the same shapes BigQuery emits: YYYY-MM-DD, YYYY-MM-DDTHH:MM:SS[.ffffff], YYYY-MM-DD HH:MM:SS[.ffffff] [UTC]. Useful when comparing temporal columns against literal date strings.

**Example:** `date_col = DATE("2026-05-20")`

### Null checks

#### `ISNULL(value)`

TRUE when the value is NULL, FALSE otherwise.

**Example:** `ISNULL(str_col)`

#### `ISBLANK(value)`

TRUE when the value is NULL or an empty string. Mirrors Excel/Sheets behavior.

**Example:** `ISBLANK(str_col)`

### Aggregations

#### `COUNTIF(column_ref, criterion)`

Counts rows in the current result where `column_ref` matches the criterion. The first argument must be a bare column reference (not an expression). The criterion can be a direct value (equality), a string starting with a comparison operator like `">30"` / `"<=100"` / `"<>x"`, or a string with wildcards (`*` `?` `%` `_`) for pattern matching. NULL values never match. Use `\` to escape wildcards: `"abc\*"` matches the literal string `abc*`.

**Example:** `COUNTIF(str_col, str_col) > 30`

#### `COUNTIFS(col1, criterion1, col2, criterion2, ...)`

Counts rows in the current result where every (column, criterion) pair matches. Same criterion syntax as COUNTIF — direct value, operator-prefix string, or wildcard string. All odd-positioned arguments must be column references; arities are pairs (even total count).

**Example:** `COUNTIFS(str_col, str_col, num_col, ">100") > 5`

## Common patterns

Practical formulas you can paste verbatim and adapt:

### Null / blank checks
```
ISNULL(str_col)                            -- column is null
NOT(ISNULL(str_col))                       -- column is set
ISBLANK(str_col)                           -- null OR empty string
```

### Numeric thresholds
```
num_col > 100
AND(num_col >= 60, num_col <= 300)         -- range (replaces BETWEEN)
ABS(num_col) > 30                          -- threshold either direction
ROUND(num_col, 2) <> num_col               -- more than 2 decimal places
```

### Even / odd / stripes
```
MOD(num_col, 2) = 0                        -- "every even-count row"
MOD(num_col, 10) < 3                       -- "first 3 of every 10"
```

### String matching
```
CONTAINS(LOWER(str_col), "abc")            -- case-insensitive substring
LEN(str_col) > 200                         -- "long values"
UPPER(str_col) = "ACTIVE"                  -- normalize before compare
OR(str_col = "active", str_col = "pending") -- multi-value match (no IN)
```

### Dates and time windows
```
YEAR(date_col) = 2026
AND(YEAR(date_col) = 2026, MONTH(date_col) = 5) -- specific month
date_col >= TODAY()                        -- today or future
date_col = DATE("2026-05-20")              -- exact date match
AND(date_col >= DATE("2026-01-01"), date_col < DATE("2026-02-01"))
```

### Compound logic
```
IF(num_col > 300, NOT(ISNULL(str_col)), FALSE)
AND(NOT(ISNULL(str_col)), num_col > 100, str_col <> "active")
OR(ISNULL(str_col), str_col = "unknown")
```

### Cross-row counts (COUNTIF / COUNTIFS)
```
COUNTIF(str_col, str_col) > 30           -- this value appears > 30 times
COUNTIF(str_col, "active") > 0           -- any matching rows exist? (rule applies to all)
COUNTIFS(str_col, str_col, num_col, ">100") > 5
                                         -- > 5 rows share this str_col AND have num_col > 100
COUNTIF(num_col, ">300") >= 3            -- there are 3+ rows above 300
COUNTIF(str_col, "*text*") > 0           -- pattern: any row contains "text"
```

The first argument must be a bare column reference. The second argument (the criterion) supports four forms — see the next section.

## COUNTIF / COUNTIFS criterion syntax

`COUNTIF(col, criterion)` and `COUNTIFS(col1, c1, col2, c2, ...)` are the only aggregations in the language. Every other function sees one row at a time; these iterate the entire current result.

The first argument **must** be a column reference (e.g. `str_col` or `` `my column` ``). Expressions like `LOWER(str_col)` aren't accepted there — the language treats the column reference as the source range, not as an expression to evaluate per row.

The criterion (second / fourth / sixth… argument) is evaluated against the *current* row, then matched against every row in the result. It can take one of four shapes:

### 1. Direct value → equality
```
COUNTIF(str_col, str_col)       -- count rows whose str_col = this row's str_col
COUNTIF(str_col, "active")      -- count rows whose str_col = "active" exactly
COUNTIF(num_col, 100)           -- count rows whose num_col = 100
```
Type-strict — no coercion. `"5" = 5` does not match. NULL row values never count, even when matched against NULL.

### 2. Operator-prefixed string → comparison
A string that begins with `>=`, `<=`, `<>`, `>`, `<`, or `=` is parsed as `<operator><operand>`. The operand is interpreted as a number when it parses as one, an ISO date when it parses as one, otherwise as a string.

```
COUNTIF(num_col, ">100")             -- num_col > 100 (numeric)
COUNTIF(num_col, ">=300")
COUNTIF(str_col, "<>active")         -- str_col is not "active"
COUNTIF(date_col, ">2026-01-01")     -- DATE column > 2026-01-01
COUNTIF(str_col, "=active")          -- explicit equality (same as direct value)
COUNTIF(str_col, "<>vip*")           -- str_col does NOT match the pattern vip*
COUNTIF(str_col, "=*foo")            -- str_col matches the pattern *foo
```
`=` and `<>` combine with wildcards: a wildcard operand is matched as a pattern (`<>` means "does not match"). This is the only way to count rows that *don't* match a pattern. The ordered operators (`>`, `<`, `>=`, `<=`) take the operand literally — wildcards are meaningless for an ordered comparison, so `">active*"` means "greater than the literal string `active*`".

### 3. Wildcard string → pattern match
A string containing `*`, `?`, `%`, or `_` is treated as a wildcard pattern. Sheets-style and SQL-style wildcards are interchangeable:

| Wildcard | Means | SQL alias |
| --- | --- | --- |
| `*` | zero or more characters | `%` |
| `?` | exactly one character | `_` |

```
COUNTIF(str_col, "abc*")             -- starts with "abc"
COUNTIF(str_col, "abc%")             -- same, SQL form
COUNTIF(str_col, "*text*")           -- contains "text"
COUNTIF(str_col, "abc?123")          -- single-char wildcard
```
Wildcard matching is **case-sensitive**. The column-reference rule means you can't wrap the column in `LOWER(...)` to bypass it; if you need case-insensitive matching, normalize at SQL time or stick to direct-value equality with `LOWER()` applied at the SQL layer.

### 4. Escape character `\`
Use `\` inside a criterion string to make the next character literal. Active only for the wildcard characters and the backslash itself:

| Sequence | Means |
| --- | --- |
| `\*` | literal `*` |
| `\?` | literal `?` |
| `\%` | literal `%` |
| `\_` | literal `_` |
| `\\` | literal `\` |
| `\` + anything else | the `\` stays verbatim (forgiving) |

```
COUNTIF(str_col, "abc\*")           -- equals the literal string "abc*"
COUNTIF(str_col, "*\**")            -- pattern: contains a literal "*"
COUNTIF(str_col, "100\%")           -- equals the literal string "100%"
COUNTIF(str_col, "\\path")         -- equals the literal string "\path"
```

### What COUNTIF criteria can't express

- **Strings that genuinely start with an operator character.** A criterion `">30"` is always parsed as a comparison; there's no escape for the operator prefix. If you need to count rows whose value equals the string `">30"`, use a plain `col = ">30"` rule instead.
- **Case-insensitive wildcards** without normalizing in SQL first (see above).
- **Regex.** Use multiple `CONTAINS` / wildcard criteria combined with `OR` if you need more than one pattern.

## Behavior notes

- **Rule priority.** The list is evaluated top-down per row; the first match wins. Use the ▲ / ▼ buttons in the popover to reorder.
- **Missing columns are non-blocking.** A formula that references a column not in the current result sits idle with a ⚠ in the rules list. Run a different query in the same file that does have the column and the rule starts matching again — no edit required.
- **Type mismatches are non-blocking too.** Comparing a string column to a number literal (column type changed between queries, say) skips that row silently rather than failing the rule.
- **Rules + click highlighting.** When a rule matches a row, the rule paints the data cells and a row click (color picker in the footer) paints only the row-number gutter as a small square. Rows without any matching rule behave like before — a click paints the whole row.
- **Persistence.** Rules live in `workspaceState` keyed by the file URI. They survive VS Code restarts, follow `.sql` file renames, and are deep-copied to any file you duplicate in the workspace (matched by content hash). Closing a tab does not delete rules; deleting the file does.
- **Per-statement.** Rules apply per-statement when drilled into a multi-statement script. Each statement has its own column set — a rule that references columns missing from one statement still works on another.

## Intentional omissions

Things SQL/Sheets users might reach for that this language doesn't have, on purpose:

- Most aggregations (`SUM`, `AVG`, `MIN`, `MAX`). The only aggregations supported are `COUNTIF` and `COUNTIFS`.
- Subqueries, joins, cross-row references.
- Regex (`REGEXP_CONTAINS`, `RLIKE`). Use `CONTAINS` + `LOWER` / `UPPER` for substring matching.
- User-defined functions.
- Cell-range references (`A1:A10`), row indices, column letters.
- Format / display functions (`TEXT`, `FORMAT_DATE`). Rules see typed values; display is the grid's job.
- `BETWEEN`, `IN`, `LIKE`. Express via combinations of the supported operators (see Common patterns).
- Hide / show actions on rules — rules color rows only, never hide them.

