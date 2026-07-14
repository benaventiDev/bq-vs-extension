import type { ParsedColumn } from '../../bq/parseJson';
import { compareDecimalStrings } from '../decimal';

// Sentinel object used in distinct-value lists to represent NULL / blank.
// We keep it as a real object so the values array can hold any non-blank
// primitive alongside this without ambiguity (a literal string "(Blanks)"
// would collide with an actual cell value of "(Blanks)").
export const BLANK_SENTINEL = { __blank: true } as const;
export type BlankSentinel = typeof BLANK_SENTINEL;
export type DistinctValue = BlankSentinel | unknown;

export function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

// Stable display string for any distinct value. Dates → ISO; otherwise the
// String(...) coercion of the raw value. The Blanks sentinel never reaches
// here — UI code formats it as "(Blanks)" explicitly.
export function formatDistinctValue(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// Stable lookup key for any cell value — used to test whether a given row's
// value is in the excluded set. Dates compare by their epoch (object identity
// won't work because the grid may produce fresh Date instances). Everything
// else uses its own primitive value.
export function valueKey(v: unknown): string | symbol {
  if (isBlank(v)) return '__blank__';
  if (v instanceof Date) return `__date__${v.getTime()}`;
  if (typeof v === 'number') return `__num__${v}`;
  if (typeof v === 'boolean') return `__bool__${v}`;
  return `__str__${String(v)}`;
}

// Compute distinct values for a column from a row set. Sort rules:
//   - Blanks always first (when present), under a single sentinel.
//   - Numbers ascending.
//   - Dates chronological.
//   - Strings (and the boolean / fallback case) ascending case-insensitive,
//     with a secondary case-sensitive tiebreak so "Apple" / "apple" don't
//     collapse into each other.
// Field-lookup is by dot-notation aware path — the rest of the webview
// already stores dot-notation top-level fields directly on the row object
// (see buildColDef), so a plain bracket lookup works without traversal.
export function computeDistinctValues(
  rows: ReadonlyArray<Record<string, unknown>>,
  field: string,
  type: ParsedColumn['type'],
): DistinctValue[] {
  const seen = new Map<string | symbol, unknown>();
  let hasBlank = false;
  for (const row of rows) {
    const v = (row as Record<string, unknown>)[field];
    if (isBlank(v)) {
      hasBlank = true;
      continue;
    }
    const k = valueKey(v);
    if (!seen.has(k)) seen.set(k, v);
  }

  const values = Array.from(seen.values());
  sortDistinct(values, type);

  if (hasBlank) return [BLANK_SENTINEL, ...values];
  return values;
}

function sortDistinct(values: unknown[], type: ParsedColumn['type']): void {
  if (type === 'number') {
    values.sort((a, b) => Number(a) - Number(b));
    return;
  }
  if (type === 'decimal') {
    // NUMERIC / BIGNUMERIC values are exact strings — sort them numerically
    // with full precision (Number() would mis-order high-precision values).
    values.sort((a, b) => compareDecimalStrings(a, b));
    return;
  }
  if (type === 'date' || type === 'datetime' || type === 'timestamp' || type === 'time') {
    // Temporal cells are raw BigQuery strings with a fixed leading-token
    // shape (YYYY-MM-DD..., HH:MM:SS...) — lex sort is equivalent to
    // chronological sort within a column. Defensive Date fallback for any
    // straggler value not produced by parseJson.
    values.sort((a, b) => {
      const sa = a instanceof Date ? a.toISOString() : String(a);
      const sb = b instanceof Date ? b.toISOString() : String(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    return;
  }
  // strings / booleans / fallback: case-insensitive
  // primary, case-sensitive tiebreak.
  values.sort((a, b) => {
    const sa = String(a);
    const sb = String(b);
    const la = sa.toLowerCase();
    const lb = sb.toLowerCase();
    if (la < lb) return -1;
    if (la > lb) return 1;
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return 0;
  });
}
