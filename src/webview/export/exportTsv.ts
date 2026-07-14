// TSV serializer for clipboard paste-into-spreadsheet UX. Header row +
// filtered/sorted rows, tab-separated.
//
// Embedded tabs and newlines are destructive-replaced rather than quoted
// (per the M10 spec):
//   - `\t` → single space
//   - `\n` (and `\r\n`) → literal `\n` (backslash-n)
// This is cleaner than quoting for the spreadsheet-paste use case: Excel /
// Sheets do not recognize CSV-style quoting in clipboard TSV reliably, so
// quoting would land badly. The trade-off is documented in the README.

import type { ParsedColumn, ParsedRow } from '../../bq/parseJson';
import { serializeForFlat } from './serialize';

function sanitizeForTsv(value: string): string {
  if (value.length === 0) return value;
  let out = value;
  if (out.indexOf('\t') !== -1) out = out.replace(/\t/g, ' ');
  if (out.indexOf('\r') !== -1 || out.indexOf('\n') !== -1) {
    out = out.replace(/\r\n/g, '\\n').replace(/\r/g, '\\n').replace(/\n/g, '\\n');
  }
  return out;
}

export function buildTsv(columns: ParsedColumn[], rows: ParsedRow[]): string {
  const header = columns.map((c) => sanitizeForTsv(c.field)).join('\t');
  const lines: string[] = [header];
  for (const row of rows) {
    const cells: string[] = [];
    for (const c of columns) {
      const v = row[c.field];
      cells.push(sanitizeForTsv(serializeForFlat(v, c.type)));
    }
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}
