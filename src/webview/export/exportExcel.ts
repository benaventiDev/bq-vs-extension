// Excel (.xlsx) generator backed by exceljs. exceljs's "browser" field
// points at the pre-bundled dist/exceljs.min.js, so esbuild picks that up
// under platform: 'browser' without trying to bundle Node-only deps
// (stream / fs / zlib).
//
// One sheet named 'Result' with a header row + filtered/sorted data rows.
// Cell types come from serializeForExcel: Date → Excel date, number/bool →
// native, struct/array/json → one-line JSON string. NULL becomes a blank
// cell.

import ExcelJS from 'exceljs';
import type { ParsedColumn, ParsedRow } from '../../bq/parseJson';
import { serializeForExcel } from './serialize';

export async function buildExcelBytes(
  columns: ParsedColumn[],
  rows: ParsedRow[],
): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'BigQuery Runner';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Result');

  // Header
  sheet.addRow(columns.map((c) => c.field));

  // Data
  for (const row of rows) {
    const out: unknown[] = [];
    for (const c of columns) {
      out.push(serializeForExcel(row[c.field], c.type));
    }
    sheet.addRow(out);
  }

  // Force temporal columns to text-format. serializeForExcel already returns
  // strings for these, so exceljs writes them as Excel string cells — but
  // setting numFmt='@' makes the intent explicit and survives any Excel
  // "smart" auto-format pass on first open.
  columns.forEach((c, idx) => {
    if (c.type === 'date' || c.type === 'datetime' || c.type === 'timestamp' || c.type === 'time') {
      sheet.getColumn(idx + 1).numFmt = '@';
    }
  });

  // Bold header for a tiny bit of polish — single-row, no overhead worth
  // worrying about even on 1M-cell sheets.
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };

  const buf = await workbook.xlsx.writeBuffer();
  // exceljs's writeBuffer() returns either an ArrayBuffer or a
  // Node.js Buffer depending on environment. Normalize to Uint8Array so
  // postMessage's structured-clone path handles it identically (vscode's
  // webview-host bridge will land it as a Uint8Array on the host side).
  if (buf instanceof Uint8Array) return buf;
  return new Uint8Array(buf as ArrayBuffer);
}
