// Footer export button + popup menu. Click → menu with CSV / Excel / JSON
// / Copy to clipboard (TSV). Each item triggers the corresponding export
// immediately. Save dialog runs on the host side; clipboard write also
// runs on the host (vscode.env.clipboard.writeText).
//
// "Current visible rows" semantics: enumerated via
// gridApi.forEachNodeAfterFilterAndSort, in the grid's current column
// order (after the user has reordered columns / hidden any). Pagination is
// a viewing affordance — all pages' rows are exported.

import type { GridApi } from 'ag-grid-community';
import type { ParsedColumn, ParsedRow } from '../../bq/parseJson';
import { buildCsv } from './exportCsv';
import { buildTsv } from './exportTsv';
import { buildJson } from './exportJson';
import { buildExcelBytes } from './exportExcel';

// Hard cap from the M10 spec. Above this many rows the clipboard option
// surfaces a notice; the user is directed to CSV download for completeness.
export const CLIPBOARD_ROW_CAP = 10_000;

export interface ExportButtonCallbacks {
  // Returns the AG Grid API for the currently-mounted SELECT grid, or null
  // if no grid is mounted (overview / banner / running / error).
  getGridApi: () => GridApi | null;
  // Columns of the currently-active statement (in source order — used to
  // map field names to types for cell serialization).
  getColumns: () => ParsedColumn[];
  // Base name for the saved file (no extension, no statement suffix). Eg
  // 'query' for 'query.sql'. The button appends '-stmtN' for
  // multi-statement + '.<ext>'.
  getFileBasename: () => string;
  // 1-based statement index for multi-statement; null for single-statement
  // (no suffix added to the filename).
  getStatementIndex: () => number | null;
  // Send the prepared payload to the host for file save.
  sendSaveRequest: (req: ExportSaveRequest) => void;
  // Send a clipboard-write request to the host.
  sendClipboardRequest: (req: ExportClipboardRequest) => void;
  // Show a brief footer status message (success / error / cap notice).
  showStatus: (text: string, kind: 'ok' | 'warn' | 'err') => void;
}

export type ExportFormat = 'csv' | 'xlsx' | 'json';

export interface ExportSaveRequest {
  requestId: string;
  format: ExportFormat;
  defaultFilename: string;
  // String for csv / json. Uint8Array for xlsx (binary).
  content: string | Uint8Array;
}

export interface ExportClipboardRequest {
  requestId: string;
  text: string;
  rowCount: number;
}

let exportMenuRef: HTMLDivElement | null = null;
let exportDocClickHandler: ((e: MouseEvent) => void) | null = null;
let exportEscHandler: ((e: KeyboardEvent) => void) | null = null;

function closeExportMenu(): void {
  if (exportMenuRef) {
    // Run any per-menu teardown (resize listener, etc.) before detaching.
    const cleanup = (exportMenuRef as HTMLElement & { __cleanup?: () => void }).__cleanup;
    if (cleanup) cleanup();
    if (exportMenuRef.parentElement) {
      exportMenuRef.parentElement.removeChild(exportMenuRef);
    }
  }
  exportMenuRef = null;
  if (exportDocClickHandler) {
    document.removeEventListener('mousedown', exportDocClickHandler, true);
    exportDocClickHandler = null;
  }
  if (exportEscHandler) {
    document.removeEventListener('keydown', exportEscHandler, true);
    exportEscHandler = null;
  }
}

/**
 * Position the menu in viewport (fixed) coordinates, anchored above the
 * button. We try right-aligning to the button (matches the theme/condfmt
 * popover feel), then clamp to a 8 px gutter on either side of the
 * viewport so the menu never escapes off-screen — which was the bug:
 * `right: 0` + a 220 px menu overflowed the left edge of the panel when
 * the button was close to the left.
 */
function positionExportMenu(menu: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.right = 'auto';
  menu.style.top = 'auto';
  // offsetWidth needs the menu to be in the DOM, which it is by the time
  // this runs (caller appends first, then calls us). Fall back to the CSS
  // min-width if offsetWidth is somehow 0 (defensive).
  const menuWidth = menu.offsetWidth || 220;
  const menuHeight = menu.offsetHeight || 160;
  const GUTTER = 8;
  let left = rect.right - menuWidth;
  if (left < GUTTER) left = GUTTER;
  if (left + menuWidth > window.innerWidth - GUTTER) {
    left = window.innerWidth - menuWidth - GUTTER;
  }
  menu.style.left = `${left}px`;
  // Prefer opening above the button (footer is at the bottom of the
  // webview); if there isn't enough room above, fall back to below.
  const spaceAbove = rect.top - GUTTER;
  if (spaceAbove >= menuHeight + 6) {
    menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  } else {
    menu.style.bottom = 'auto';
    menu.style.top = `${rect.bottom + 6}px`;
  }
}

export function closeExportMenuExternally(): void {
  closeExportMenu();
}

function downloadIconSvg(): string {
  // Down-arrow into a tray. Single-color (currentColor) so it inherits
  // from the theme-aware button.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 2.5v8"/>
    <path d="M4.5 7l3.5 3.5L11.5 7"/>
    <path d="M2.5 13h11"/>
  </svg>`;
}

export function renderExportButton(cb: ExportButtonCallbacks): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'export-btn-wrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'export-btn';
  btn.innerHTML = downloadIconSvg();
  btn.title = 'Export result';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (exportMenuRef) {
      closeExportMenu();
    } else {
      openExportMenu(btn, cb);
    }
  });

  wrap.appendChild(btn);
  return wrap;
}

function openExportMenu(anchor: HTMLElement, cb: ExportButtonCallbacks): void {
  closeExportMenu();

  const api = cb.getGridApi();
  if (!api) return; // grid not mounted — button should not have been rendered

  const menu = document.createElement('div');
  menu.className = 'export-menu';

  const rowCount = countFilteredRows(api);

  menu.appendChild(makeMenuItem('CSV', 'Save as .csv', () => {
    closeExportMenu();
    doExportCsv(cb);
  }));
  menu.appendChild(makeMenuItem('Excel', 'Save as .xlsx', () => {
    closeExportMenu();
    void doExportExcel(cb);
  }));
  menu.appendChild(makeMenuItem('JSON', 'Save as .json', () => {
    closeExportMenu();
    doExportJson(cb);
  }));

  if (rowCount <= CLIPBOARD_ROW_CAP) {
    menu.appendChild(makeMenuItem(
      'Copy to clipboard',
      `TSV — ${rowCount.toLocaleString()} row${rowCount === 1 ? '' : 's'}`,
      () => {
        closeExportMenu();
        doExportClipboard(cb);
      },
    ));
  } else {
    // Show the cap notice as a disabled item — clicking is a no-op.
    const item = makeMenuItem(
      'Copy to clipboard',
      `Result has ${rowCount.toLocaleString()} rows. Clipboard limited to ${CLIPBOARD_ROW_CAP.toLocaleString()} — use CSV download instead.`,
      () => {
        // No-op. Cap is informational.
      },
    );
    item.classList.add('disabled');
    item.setAttribute('aria-disabled', 'true');
    menu.appendChild(item);
  }

  // Attach to <body> with position: fixed + viewport-clamped coords. The
  // earlier `position: absolute; right: 0` approach worked for the narrow
  // (~120 px) theme popover but the 220 px export menu overflowed off the
  // left of the panel when the button sat too close to the left edge or
  // the panel was narrow. Detaching from the footer also sidesteps any
  // overflow: hidden clipping on ancestor nodes.
  document.body.appendChild(menu);
  positionExportMenu(menu, anchor);
  exportMenuRef = menu;

  // Re-clamp on resize so a window/panel resize while the menu is open
  // doesn't leave it dangling off-screen. Cheap; menu is short-lived.
  const onResize = () => {
    if (exportMenuRef) positionExportMenu(exportMenuRef, anchor);
  };
  window.addEventListener('resize', onResize);
  // Stash the cleanup on the menu element so closeExportMenu can remove it.
  (menu as HTMLElement & { __cleanup?: () => void }).__cleanup = () => {
    window.removeEventListener('resize', onResize);
  };

  exportDocClickHandler = (e: MouseEvent) => {
    if (!exportMenuRef) return;
    const target = e.target as Node | null;
    if (target && (exportMenuRef.contains(target) || anchor.contains(target))) return;
    closeExportMenu();
  };
  document.addEventListener('mousedown', exportDocClickHandler, true);

  exportEscHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeExportMenu();
    }
  };
  document.addEventListener('keydown', exportEscHandler, true);
}

function makeMenuItem(label: string, sub: string, onClick: () => void): HTMLButtonElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'export-menu-item';

  const labelEl = document.createElement('span');
  labelEl.className = 'export-menu-label';
  labelEl.textContent = label;
  item.appendChild(labelEl);

  const subEl = document.createElement('span');
  subEl.className = 'export-menu-sub';
  subEl.textContent = sub;
  item.appendChild(subEl);

  item.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return item;
}

function countFilteredRows(api: GridApi): number {
  let n = 0;
  api.forEachNodeAfterFilterAndSort(() => {
    n++;
  });
  return n;
}

/**
 * Collect rows in the grid's current filter+sort order, projecting only
 * the fields that map to visible non-gutter data columns in their current
 * visual order. Hidden columns (none today, but future-proof) are excluded.
 */
function collectExportData(
  api: GridApi,
  cols: ParsedColumn[],
): { columns: ParsedColumn[]; rows: ParsedRow[] } {
  const typeByField = new Map(cols.map((c) => [c.field, c.type]));

  const orderedCols: ParsedColumn[] = [];
  const allCols = api.getAllDisplayedColumns() ?? api.getColumns() ?? [];
  for (const col of allCols) {
    const def = col.getColDef();
    const field = def.field;
    if (!field) continue; // skip the row-number gutter
    const type = typeByField.get(field);
    if (type === undefined) continue; // exploded / dotted columns that aren't in the source set
    orderedCols.push({ field, type });
  }
  // Fallback: if the grid hasn't laid out columns yet (shouldn't happen
  // when the menu opens — grid is already mounted), fall back to source
  // order so the export isn't empty.
  const finalCols = orderedCols.length > 0 ? orderedCols : cols;

  const rows: ParsedRow[] = [];
  api.forEachNodeAfterFilterAndSort((node) => {
    if (!node.data) return;
    const row: ParsedRow = {};
    for (const c of finalCols) {
      row[c.field] = (node.data as Record<string, unknown>)[c.field];
    }
    rows.push(row);
  });

  return { columns: finalCols, rows };
}

function makeRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultFilenameFor(cb: ExportButtonCallbacks, ext: string): string {
  const base = cb.getFileBasename();
  const stmt = cb.getStatementIndex();
  const stmtSuffix = stmt !== null ? `-stmt${stmt}` : '';
  return `${base}${stmtSuffix}-result.${ext}`;
}

function doExportCsv(cb: ExportButtonCallbacks): void {
  const api = cb.getGridApi();
  if (!api) return;
  const { columns, rows } = collectExportData(api, cb.getColumns());
  const content = buildCsv(columns, rows);
  cb.sendSaveRequest({
    requestId: makeRequestId('csv'),
    format: 'csv',
    defaultFilename: defaultFilenameFor(cb, 'csv'),
    content,
  });
}

function doExportJson(cb: ExportButtonCallbacks): void {
  const api = cb.getGridApi();
  if (!api) return;
  const { columns, rows } = collectExportData(api, cb.getColumns());
  const content = buildJson(columns, rows);
  cb.sendSaveRequest({
    requestId: makeRequestId('json'),
    format: 'json',
    defaultFilename: defaultFilenameFor(cb, 'json'),
    content,
  });
}

async function doExportExcel(cb: ExportButtonCallbacks): Promise<void> {
  const api = cb.getGridApi();
  if (!api) return;
  const { columns, rows } = collectExportData(api, cb.getColumns());
  // exceljs.writeBuffer() can take several seconds on a 25k × 30-col sheet;
  // surface a "generating" hint while it runs.
  cb.showStatus('Generating Excel file…', 'ok');
  try {
    const content = await buildExcelBytes(columns, rows);
    cb.sendSaveRequest({
      requestId: makeRequestId('xlsx'),
      format: 'xlsx',
      defaultFilename: defaultFilenameFor(cb, 'xlsx'),
      content,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cb.showStatus(`Excel export failed: ${msg}`, 'err');
  }
}

function doExportClipboard(cb: ExportButtonCallbacks): void {
  const api = cb.getGridApi();
  if (!api) return;
  const { columns, rows } = collectExportData(api, cb.getColumns());
  if (rows.length > CLIPBOARD_ROW_CAP) {
    // Defensive — UI should have shown the cap notice instead of letting
    // this code path fire. Keep the guard so we never silently truncate.
    cb.showStatus(
      `Result has ${rows.length.toLocaleString()} rows; clipboard limited to ${CLIPBOARD_ROW_CAP.toLocaleString()}. Use CSV download instead.`,
      'warn',
    );
    return;
  }
  const text = buildTsv(columns, rows);
  cb.sendClipboardRequest({
    requestId: makeRequestId('clip'),
    text,
    rowCount: rows.length,
  });
}
