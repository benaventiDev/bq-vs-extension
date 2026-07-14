// Cell-value serialization shared across all export formats.
//
// Per the M10 spec, refined by the timestamp-fidelity patch:
//   Scalars (string/int/float/bool) → primitive
//   DATE / DATETIME / TIMESTAMP / TIME → raw BigQuery string, verbatim
//                                       (no toISOString reformat — the
//                                        whole point of the fidelity patch
//                                        is to preserve microseconds and
//                                        the ` UTC` suffix Excel/Date
//                                        coercion would otherwise drop)
//   Bytes                            → as-is (already a base64 string)
//   Struct / Array / JSON            → JSON.stringify(value) one-line for
//                                      flat-cell formats (CSV/TSV/Excel);
//                                      preserved natively for JSON export.
//   NULL/undefined                   → null

import type { ColumnType } from '../../bq/parseJson';

function isTemporalType(type: ColumnType): boolean {
  return (
    type === 'date' ||
    type === 'datetime' ||
    type === 'timestamp' ||
    type === 'time'
  );
}

/**
 * Serialize a cell value for a flat-cell format (CSV / TSV / Excel string
 * cell). Returns a string ('' for null). Nested types collapse to a single
 * line of JSON.
 */
export function serializeForFlat(value: unknown, type: ColumnType): string {
  if (value === null || value === undefined) return '';
  // Temporal columns: pass the raw BigQuery string through. parseJson keeps
  // these as strings (post-fidelity patch); the Date branch is defensive.
  if (isTemporalType(type)) {
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (type === 'struct' || type === 'array' || type === 'json') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return String(value);
}

/**
 * Serialize for JSON export. Preserves native types: numbers stay numeric,
 * booleans stay boolean, structs/arrays stay nested. Dates → ISO string
 * (JSON.stringify handles Date natively, but we coerce explicitly so the
 * caller never sees an enumerable Date object in the row map).
 */
export function serializeForJson(value: unknown, type: ColumnType): unknown {
  if (value === null || value === undefined) return null;
  // Temporal columns: keep the raw BQ string so JSON exports mirror what
  // the grid shows (with microseconds + UTC suffix). Defensive Date branch
  // for any straggler value.
  if (isTemporalType(type)) {
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Serialize for Excel. Returns a typed value:
 *   - string (raw BQ text) for date/datetime/timestamp/time — we deliberately
 *     do NOT hand Excel a typed date cell here. The fidelity patch keeps
 *     the original string with microseconds + ` UTC` suffix; Excel date
 *     cells would re-truncate and reformat, defeating the whole point.
 *   - number for numbers
 *   - boolean for booleans
 *   - string for everything else (including nested → JSON one-liner, and
 *     bytes which arrive as base64 strings)
 *   - null for empty
 *
 * exceljs uses the JS type at runtime to pick the Excel cell type, so a
 * string here lands as an Excel text cell — Excel won't auto-coerce it.
 */
export function serializeForExcel(value: unknown, type: ColumnType): unknown {
  if (value === null || value === undefined) return null;
  if (isTemporalType(type)) {
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }
  if (value instanceof Date) return value;
  if (type === 'struct' || type === 'array' || type === 'json') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}
