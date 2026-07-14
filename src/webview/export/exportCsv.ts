// RFC 4180 CSV serializer. Header row + all filtered/sorted rows.
//
// Quoting rules (RFC 4180):
//   - A field is double-quoted whenever it contains a comma, a quote, a CR,
//     or an LF.
//   - Inside a quoted field, every literal `"` is escaped as `""`.
//   - Line terminator is CRLF.
//
// Encoding: output is prefixed with a UTF-8 BOM (U+FEFF). Excel-on-Windows
// otherwise opens .csv as the local code page (CP1252 in Western locales),
// mangling accented characters. The BOM forces UTF-8 decode. Modern Excel,
// LibreOffice Calc, Google Sheets, and Numbers all handle the BOM cleanly.

import type { ParsedColumn, ParsedRow } from '../../bq/parseJson';
import { serializeForFlat } from './serialize';

const NEEDS_QUOTE_RE = /[",\r\n]/;
const UTF8_BOM = '﻿';

function quoteField(value: string): string {
  if (!NEEDS_QUOTE_RE.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildCsv(columns: ParsedColumn[], rows: ParsedRow[]): string {
  const header = columns.map((c) => quoteField(c.field)).join(',');
  const lines: string[] = [header];
  for (const row of rows) {
    const cells: string[] = [];
    for (const c of columns) {
      const v = row[c.field];
      cells.push(quoteField(serializeForFlat(v, c.type)));
    }
    lines.push(cells.join(','));
  }
  return UTF8_BOM + lines.join('\r\n');
}
