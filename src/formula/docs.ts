// Single source of truth for the M8 formula language reference. The inline
// help panel, Monaco hover/autocomplete, and docs/formula-language.md all
// read from these arrays. Keeping the three surfaces in sync requires that
// every addition or signature change happens here first.

export interface FunctionDoc {
  name: string;
  category: 'logical' | 'math' | 'text' | 'date' | 'null' | 'aggregate';
  signature: string;
  description: string;
  example: string;
  // Min and max arity (inclusive). For variadic functions (AND, OR), set
  // maxArity to Infinity. Argument types are documented narratively in
  // `description` rather than enforced at parse time — the evaluator does
  // runtime coercion and surfaces type mismatches as the non-blocking
  // "rule did not apply" path.
  minArity: number;
  maxArity: number;
}

export const FUNCTIONS: FunctionDoc[] = [
  // Logical
  {
    name: 'IF',
    category: 'logical',
    signature: 'IF(condition, value_if_true, value_if_false)',
    description:
      'Returns the second argument when the condition is truthy, otherwise the third. NULL conditions are treated as falsy.',
    example: 'IF(num_col > 100, "high", "low")',
    minArity: 3,
    maxArity: 3,
  },
  {
    name: 'AND',
    category: 'logical',
    signature: 'AND(cond1, cond2, ...)',
    description:
      'TRUE when every argument is truthy. NULL arguments are treated as falsy. Also available as an infix operator.',
    example: 'AND(num_col > 100, NOT(ISNULL(str_col)))',
    minArity: 1,
    maxArity: Infinity,
  },
  {
    name: 'OR',
    category: 'logical',
    signature: 'OR(cond1, cond2, ...)',
    description:
      'TRUE when at least one argument is truthy. Also available as an infix operator.',
    example: 'OR(num_col > 100, str_col = "active")',
    minArity: 1,
    maxArity: Infinity,
  },
  {
    name: 'NOT',
    category: 'logical',
    signature: 'NOT(value)',
    description:
      'Inverts the truthiness of the argument. NOT(NULL) is NULL (treated as falsy in rule context).',
    example: 'NOT(ISNULL(str_col))',
    minArity: 1,
    maxArity: 1,
  },

  // Math
  {
    name: 'MOD',
    category: 'math',
    signature: 'MOD(a, b)',
    description:
      'Returns the remainder of a divided by b. Both arguments must be numbers; division by zero returns NULL.',
    example: 'MOD(num_col, 2) = 0',
    minArity: 2,
    maxArity: 2,
  },
  {
    name: 'ABS',
    category: 'math',
    signature: 'ABS(n)',
    description: 'Returns the absolute value of a number.',
    example: 'ABS(num_col) > 100',
    minArity: 1,
    maxArity: 1,
  },
  {
    name: 'ROUND',
    category: 'math',
    signature: 'ROUND(n, digits)',
    description:
      'Rounds n to the given number of decimal digits. Negative digits round to tens/hundreds.',
    example: 'ROUND(num_col, 2) > 5.25',
    minArity: 2,
    maxArity: 2,
  },

  // Text
  {
    name: 'CONTAINS',
    category: 'text',
    signature: 'CONTAINS(text, substring)',
    description:
      'Returns TRUE when `text` contains `substring` as a substring. Case-sensitive.',
    example: 'CONTAINS(str_col, "text")',
    minArity: 2,
    maxArity: 2,
  },
  {
    name: 'LEN',
    category: 'text',
    signature: 'LEN(text)',
    description: 'Returns the length of the string in characters.',
    example: 'LEN(str_col) > 10',
    minArity: 1,
    maxArity: 1,
  },
  {
    name: 'LOWER',
    category: 'text',
    signature: 'LOWER(text)',
    description: 'Returns the string lowercased.',
    example: 'LOWER(str_col) = "value"',
    minArity: 1,
    maxArity: 1,
  },
  {
    name: 'UPPER',
    category: 'text',
    signature: 'UPPER(text)',
    description: 'Returns the string uppercased.',
    example: 'UPPER(str_col) = "VALUE"',
    minArity: 1,
    maxArity: 1,
  },

  // Date
  {
    name: 'YEAR',
    category: 'date',
    signature: 'YEAR(date_or_timestamp)',
    description:
      'Returns the 4-digit year of a DATE / DATETIME / TIMESTAMP value. Temporal cells are stored as the raw BigQuery string (e.g. "2026-04-15 18:17:12.418000 UTC") and parsed on demand, anchored to UTC.',
    example: 'YEAR(date_col) = 2026',
    minArity: 1,
    maxArity: 1,
  },
  {
    name: 'MONTH',
    category: 'date',
    signature: 'MONTH(date_or_timestamp)',
    description: 'Returns the month (1-12) of a DATE / DATETIME / TIMESTAMP, anchored to UTC.',
    example: 'MONTH(date_col) = 1',
    minArity: 1,
    maxArity: 1,
  },
  {
    name: 'DAY',
    category: 'date',
    signature: 'DAY(date_or_timestamp)',
    description:
      'Returns the day of the month (1-31) of a DATE / DATETIME / TIMESTAMP, anchored to UTC.',
    example: 'DAY(date_col) > 15',
    minArity: 1,
    maxArity: 1,
  },
  {
    name: 'TODAY',
    category: 'date',
    signature: 'TODAY()',
    description: "Returns today's date (DATE, no time component).",
    example: 'date_col >= TODAY()',
    minArity: 0,
    maxArity: 0,
  },
  {
    name: 'DATE',
    category: 'date',
    signature: 'DATE(iso_string)',
    description:
      'Parses a temporal string into a DATE value (anchored to UTC). Accepts the same shapes BigQuery emits: YYYY-MM-DD, YYYY-MM-DDTHH:MM:SS[.ffffff], YYYY-MM-DD HH:MM:SS[.ffffff] [UTC]. Useful when comparing temporal columns against literal date strings.',
    example: 'date_col = DATE("2026-05-20")',
    minArity: 1,
    maxArity: 1,
  },

  // Null checks
  {
    name: 'ISNULL',
    category: 'null',
    signature: 'ISNULL(value)',
    description: 'TRUE when the value is NULL, FALSE otherwise.',
    example: 'ISNULL(str_col)',
    minArity: 1,
    maxArity: 1,
  },
  {
    name: 'ISBLANK',
    category: 'null',
    signature: 'ISBLANK(value)',
    description:
      'TRUE when the value is NULL or an empty string. Mirrors Excel/Sheets behavior.',
    example: 'ISBLANK(str_col)',
    minArity: 1,
    maxArity: 1,
  },

  // Aggregations — these iterate the full current result, so they break the
  // "one row at a time" rule that holds for every other function. See the
  // criterion-syntax notes in docs/formula-language.md.
  {
    name: 'COUNTIF',
    category: 'aggregate',
    signature: 'COUNTIF(column_ref, criterion)',
    description:
      'Counts rows in the current result where `column_ref` matches the criterion. The first argument must be a bare column reference (not an expression). The criterion can be a direct value (equality), a string starting with a comparison operator like `">30"` / `"<=100"` / `"<>x"`, or a string with wildcards (`*` `?` `%` `_`) for pattern matching. `=` and `<>` combine with wildcards (e.g. `"<>vip*"` counts rows not matching vip*); ordered operators (`>` `<` `>=` `<=`) take the operand literally. NULL values never match. Use `\\` to escape wildcards: `"abc\\*"` matches the literal string `abc*`.',
    example: 'COUNTIF(str_col, str_col) > 30',
    minArity: 2,
    maxArity: 2,
  },
  {
    name: 'COUNTIFS',
    category: 'aggregate',
    signature: 'COUNTIFS(col1, criterion1, col2, criterion2, ...)',
    description:
      'Counts rows in the current result where every (column, criterion) pair matches. Same criterion syntax as COUNTIF — direct value, operator-prefix string, or wildcard string. All odd-positioned arguments must be column references; arities are pairs (even total count).',
    example: 'COUNTIFS(str_col, str_col, num_col, ">100") > 5',
    minArity: 2,
    maxArity: Infinity,
  },
];

export interface OperatorDoc {
  symbol: string;
  category: 'arithmetic' | 'comparison' | 'logical';
  description: string;
  example: string;
}

export const OPERATORS: OperatorDoc[] = [
  { symbol: '+', category: 'arithmetic', description: 'Addition.', example: 'col_a + col_b > 200' },
  { symbol: '-', category: 'arithmetic', description: 'Subtraction (or unary negation).', example: 'col_a - col_b > 60' },
  { symbol: '*', category: 'arithmetic', description: 'Multiplication.', example: 'col_a * col_b > 1000' },
  { symbol: '/', category: 'arithmetic', description: 'Division. Division by zero returns NULL.', example: 'col_a / col_b > 50' },
  { symbol: '=', category: 'comparison', description: 'Equality. Different types compare as not-equal.', example: 'str_col = "active"' },
  { symbol: '<>', category: 'comparison', description: 'Inequality.', example: 'str_col <> "active"' },
  { symbol: '<', category: 'comparison', description: 'Less than.', example: 'num_col < 30' },
  { symbol: '<=', category: 'comparison', description: 'Less than or equal.', example: 'num_col <= 30' },
  { symbol: '>', category: 'comparison', description: 'Greater than.', example: 'num_col > 100' },
  { symbol: '>=', category: 'comparison', description: 'Greater than or equal.', example: 'num_col >= 100' },
  { symbol: 'AND', category: 'logical', description: 'Infix logical AND (also available as AND() function).', example: 'col_a > 0 AND col_b > 0' },
  { symbol: 'OR', category: 'logical', description: 'Infix logical OR.', example: 'col_a = 1 OR col_a = 2' },
  { symbol: 'NOT', category: 'logical', description: 'Prefix logical NOT (also available as NOT() function).', example: 'NOT ISNULL(col_a)' },
];

export const SYNTAX_NOTES: { title: string; body: string }[] = [
  {
    title: 'Column references',
    body: 'Reference columns by name. Bare identifiers like `num_col` are fine; columns with spaces or special characters use backticks — the same way you quote them in BigQuery SQL: `` `my column` ``. Column matching is case-insensitive. (Quotes — `"..."` or `\'...\'` — are always string literals, never column references.)',
  },
  {
    title: 'Literals',
    body: 'Numbers (`100`, `3.14`, `-5`), strings in either double or single quotes (`"hello"`, `\'hello\'` — both work, as in BigQuery), booleans `TRUE` / `FALSE`, and `NULL`. A doubled quote escapes a literal quote inside a string (`"she said ""hi"""`).',
  },
  {
    title: 'NULL handling',
    body: 'Any comparison with NULL evaluates to NULL, which is treated as falsy in rule context (rule does not match). Use `ISNULL(x)` or `ISBLANK(x)` to test explicitly.',
  },
  {
    title: 'Type comparisons',
    body: 'Comparisons between different types (e.g. number vs string) evaluate as not-equal — there is no silent coercion. Temporal cells (DATE / DATETIME / TIMESTAMP / TIME) are stored as the raw BigQuery string and auto-coerced when compared against a DATE("...") literal — the language accepts every shape BQ emits, including timestamps with microseconds and ` UTC` suffix.',
  },
];

export function findFunctionDoc(name: string): FunctionDoc | undefined {
  const u = name.toUpperCase();
  return FUNCTIONS.find((f) => f.name === u);
}

export function isFunctionName(name: string): boolean {
  return findFunctionDoc(name) !== undefined;
}
