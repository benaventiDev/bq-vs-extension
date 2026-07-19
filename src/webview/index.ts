import {
  createGrid,
  ModuleRegistry,
  ClientSideRowModelModule,
  type CellClassParams,
  type CellContextMenuEvent,
  type CellDoubleClickedEvent,
  type CellMouseDownEvent,
  type CellMouseOverEvent,
  type ColDef,
  type Column,
  type ColumnState,
  type GridApi,
  type GridOptions,
  type IRowNode,
  type ITooltipParams,
  type RowClassParams,
  type ValueFormatterParams,
  type ValueGetterParams,
} from 'ag-grid-community';

import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-alpine.css';
import './styles.css';

import type {
  HostToWebviewMessage,
  NestedRenderMode,
  ResolvedTheme,
  StatementOutcome,
  TabResult,
  TabState,
  ThemePreference,
  WebviewToHostMessage,
} from '../panel/types';
import type { ParsedColumn, ParsedRow } from '../bq/parseJson';
import {
  NestedCellRenderer,
  bytesToHex,
  isArrayOfPlainObjects,
  previewArray,
  type NestedKind,
} from './cellRenderers';
import { explodeRows } from './rowExplode';
import {
  isRulesModalOpen,
  maybeRefreshRulesPopover,
  notifyModalThemeChange,
  renderConditionalFormattingButton,
  syncRuleModalToActiveKey,
  discardModalSession,
} from './rules/rulesUi';
import type { Rule } from '../panel/rules/rulesStore';
import { parse as parseFormula } from '../formula/parser';
import { buildContext, matches } from '../formula/evaluator';
import { SheetsFilterComp, type ActiveFilterHandle } from './filters/sheetsFilter';
import type { FilterDraft, SheetsFilterModel } from './filters/sheetsFilterUi';
import { ColumnHeader, type ColumnHeaderParams } from './columnHeader';
import { compareDecimalStrings } from './decimal';
import {
  renderExportButton,
  closeExportMenuExternally,
  type ExportButtonCallbacks,
} from './export/exportButton';

ModuleRegistry.registerModules([ClientSideRowModelModule]);

interface VsCodeApi {
  postMessage(msg: unknown): void;
  setState(state: unknown): void;
  getState<T>(): T | undefined;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

const PAGE_SIZES = [100, 200, 1000] as const;
type PageSize = (typeof PAGE_SIZES)[number];

const PALETTE = [
  'yellow',
  'orange',
  'red',
  'pink',
  'purple',
  'blue',
  'cyan',
  'green',
  'brown',
] as const;
type PaletteColor = (typeof PALETTE)[number];

interface PerStatementState {
  pageSize: PageSize | null;
  clickColors: Map<number, PaletteColor>;
  // Per-row rule colors for this statement. Stored on the state object (not
  // a closure local) so we can mutate it in place when a rule is added /
  // edited / deleted and let the grid pick up the change via redrawRows()
  // instead of a full re-mount — preserves scroll position, sort, filter,
  // and pagination.
  ruleColors: Map<number, string>;
  // Per-statement render-mode override. When unset the active workspace
  // default (module-level `nestedRenderMode`) is used. Toggling the footer
  // button while a chip is drilled-in writes here; the workspace default
  // is NOT updated for multi-statement results, so each statement keeps
  // its own mode and rerunning the script resets all of them.
  renderMode?: NestedRenderMode;
  // M9: per-column filter models, keyed by column field. Survives page
  // changes, sort changes, render-mode swaps where the column still
  // exists. Reset on new query (via buildTabState replacing the map) and
  // pruned in setRenderMode for columns that disappear in the new view.
  columnFilters: Map<string, SheetsFilterModel>;
  // M12: column-header highlights, keyed by column field. Set on Ctrl/Cmd+
  // click of the header. Ephemeral — cleared on new query / file close /
  // render-mode swap. No persistence. Read by the custom header component
  // (columnHeader.ts) and toggled via toggleColumnHighlight() below.
  columnHighlights: Set<string>;
  // Consolidated AG Grid column state — captured via getColumnState() and
  // replayed via applyColumnState({ applyOrder: true }) so the order of
  // entries in this array drives the new column order. Covers, in one
  // shot: column widths, sort + sortIndex, hide (popover + drag-out),
  // pinned, AND column reordering by drag. Replaces the earlier separate
  // columnWidths Map and sortState array. Reset on new query (perStatement
  // map is rebuilt by buildTabState).
  columnState?: ColumnState[];
  // Current pagination page (0-based). pageSize above is rows-per-page;
  // this is which page the user navigated to. Captured via
  // paginationGetCurrentPage, restored via paginationGoToPage.
  currentPage?: number;
  // Vertical scroll, in pixels, captured from the `.ag-body-viewport`
  // element's scrollTop. NOT a row index — AG Grid `getFirstDisplayedRow`
  // returns 0 for small grids that render every row in the DOM (no
  // virtualization → "first displayed" is always the first row even when
  // CSS overflow is scrolled down). Restored by direct DOM scrollTop
  // assignment, which the vertical apple-scrollbar overlay syncs from.
  scrollTopPx?: number;
  // Leftmost non-pinned visible column when the grid was last torn down.
  // Restored via gridApi.ensureColumnVisible(colId, 'start'). We store
  // a colId rather than a pixel scrollLeft because AG Grid v31's apple-
  // scrollbar overlay system overrides direct DOM scrollLeft assignment
  // during its layout pass — the public API is the only reliable path
  // for horizontal scroll restoration.
  scrollLeftColId?: string;
  // In-progress filter popup, captured if the user switches tabs while a
  // column filter is OPEN (uncommitted). On the next mount we re-open that
  // column's filter and replay the draft. Cleared (consumed) on restore,
  // and cleared in disposeGrid when no popup is open. Distinct from
  // columnFilters above, which holds COMMITTED filter models.
  openFilterDraft?: { field: string; draft: FilterDraft };
  // Signature of the column set that the canvas auto-sizer was last run for.
  // The auto-sizer measures text width across EVERY row — O(rows × cols),
  // the dominant cost when re-mounting a large result on editor switch. The
  // resulting widths are already captured in `columnState` (via
  // getColumnState in disposeGrid), so on a re-mount of the SAME column set
  // we replay those widths and skip the re-measurement entirely. Keyed by
  // joined field names so a render-mode toggle (inline↔explode changes the
  // columns) correctly forces a fresh measurement. Reset on new query (the
  // perStatement map is rebuilt).
  sizedColumnsKey?: string;
  // Cell range selection (color-toggle OFF): the anchor (active cell) and head
  // (far corner), by displayed row index + colId. Persisted so leaving the file
  // and returning restores the selection exactly as the user left it — saved in
  // disposeGrid, restored last on mount. Drilling into a statement from the
  // overview clears it (drillIntoStatement) so a re-entered statement starts
  // fresh; reset on a new query (the perStatement map is rebuilt).
  cellSelection?: { anchor: CellPos; head: CellPos } | null;
}

interface WebviewTabState {
  tab: TabState;
  // Index 0 for TabResult.kind === 'ok' (single-statement); 0..N-1 for
  // TabResult.kind === 'multi' (per-statement state for SELECT outcomes).
  // Lazily initialized as the user views each statement.
  perStatement: Map<number, PerStatementState>;
  // For kind === 'multi': null = overview table is shown; number = drilled
  // into that statement's view. For kind === 'ok' / 'error' / 'running':
  // unused (the renderer ignores it).
  activeStmtIndex: number | null;
}

const tabs = new Map<string, WebviewTabState>();
// `activeKey` is the DISPLAYED result's key — what every result-operation
// helper (activeColumns/activeRows/rules/export) reads. It is derived by
// recomputeActiveKey() from the pin slot and the editor-driven key below.
let activeKey: string | null = null;
// The editor-driven tab key the host last reported (set-active.key). Equals
// the active editor's result slot, or null when the focused file has no run.
let editorTabKey: string | null = null;
// The live active .sql editor URI (set-active.activeEditorKey), independent
// of whether a result slot exists. Used only to name the focused file in the
// pin-mismatch banner. Null when no .sql editor is focused.
let activeEditorKey: string | null = null;
// PIN (this build): a single global slot. When set AND its result still
// exists, the panel displays that file's result regardless of editor focus.
// Cleared on any Shift+Enter, pinned-file close/rename, manual unpin, and
// VS Code restart (module reload resets to null — no persistence). The
// sanctioned exception to the editor-focus-is-single-source-of-truth rule;
// see memory/project_lifecycle_model.md.
let pinnedUri: string | null = null;

// Derive the displayed `activeKey` from the pin slot + editor-driven key.
// A pin whose slot has vanished (file closed mid-pin) auto-clears here so we
// never get stuck pointing at a dropped result.
function recomputeActiveKey(): void {
  if (pinnedUri !== null && !tabs.has(pinnedUri)) {
    pinnedUri = null;
  }
  activeKey = pinnedUri !== null ? pinnedUri : editorTabKey;
}

// True when a pin is active and the focused editor is a DIFFERENT file than
// the pinned one (or no .sql editor is focused). Drives the sticky banner +
// accent border. State 2 (focused file IS the pinned file) returns false.
function isPinMismatch(): boolean {
  if (pinnedUri === null || !tabs.has(pinnedUri)) return false;
  return activeEditorKey !== pinnedUri;
}

// Conditional formatting rules: stored per file URI (key). The host
// persists; we mirror here so the UI is responsive without a round-trip.
const rulesByUri = new Map<string, Rule[]>();

function getRulesFor(uri: string | null): Rule[] {
  if (!uri) return [];
  return rulesByUri.get(uri) ?? [];
}

// The RulesUiCallbacks bundle, rebuilt on demand — every accessor reads live
// module state. Shared by the conditional-formatting button, the popover
// refresh, and the per-file modal sync so they all route through the same
// (pin-aware) active key.
function buildRulesCallbacks() {
  return {
    getActiveUri: () => activeKey,
    getRules: () => getRulesFor(activeKey),
    getColumns: () => activeColumns(),
    getRows: () => activeRows(),
    saveRules: (rules: Rule[]) => saveRules(activeKey, rules),
    getResolvedTheme: () => resolvedTheme,
    requestClipboardText,
  };
}

// Pending OS-clipboard read requests. Webviews block
// navigator.clipboard.readText(), so paste has to round-trip through the
// extension host. Each request gets a unique id; the host echoes back with
// the same id so the right Promise resolves even if multiple paste calls
// were issued concurrently (unlikely in practice but cheap to support).
const pendingPasteRequests = new Map<string, (text: string) => void>();

// Tracks in-flight M10 export round-trips so the right footer-status toast
// fires when the host posts export-complete. We deliberately keep no other
// state per request (filename, format) — the host echoes anything the
// webview needs to know in the completion payload.
const pendingExportRequests = new Set<string>();

function requestClipboardText(): Promise<string> {
  const requestId = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<string>((resolve) => {
    pendingPasteRequests.set(requestId, resolve);
    post({ type: 'request-clipboard', requestId });
    // Defensive timeout: if the host never replies (shouldn't happen) we
    // resolve with empty text after 2s so the editor doesn't hang.
    setTimeout(() => {
      const r = pendingPasteRequests.get(requestId);
      if (r) {
        pendingPasteRequests.delete(requestId);
        r('');
      }
    }, 2000);
  });
}

function activeColumns(): ParsedColumn[] {
  const a = activeKey ? tabs.get(activeKey) : null;
  if (!a) return [];
  const r = a.tab.result;
  if (r.kind === 'ok') return r.columns;
  if (r.kind === 'multi' && a.activeStmtIndex !== null) {
    const stmt = r.statements[a.activeStmtIndex];
    if (stmt && stmt.kind === 'select') return stmt.columns;
  }
  return [];
}

function activeRows(): ParsedRow[] {
  const a = activeKey ? tabs.get(activeKey) : null;
  if (!a) return [];
  const r = a.tab.result;
  if (r.kind === 'ok') return r.rows;
  if (r.kind === 'multi' && a.activeStmtIndex !== null) {
    const stmt = r.statements[a.activeStmtIndex];
    if (stmt && stmt.kind === 'select') return stmt.rows;
  }
  return [];
}

function saveRules(uri: string | null, rules: Rule[]): void {
  if (!uri) return;
  // Optimistically reflect locally so the UI doesn't flicker waiting for the
  // host echo. The host echo re-confirms what's persisted.
  rulesByUri.set(uri, rules);
  post({ type: 'save-rules', uri, rules });
  if (uri === activeKey) updateRulesInPlace(uri);
}

// Repaint rule colors on the active grid without rebuilding the DOM. This
// preserves scroll, sort, filter, page, selection, etc. — important so a
// rule edit doesn't yank the user back to row 1.
//
// The path matters only when the grid is mounted (single-statement result
// or drilled-into a multi-statement SELECT). For other states (running,
// error, overview, DDL/DML banner) the badge is the only visible signal
// and we just refresh it.
function updateRulesInPlace(uri: string): void {
  if (uri !== activeKey) return;
  const active = tabs.get(uri);
  if (!active) return;

  const stmt = activeStmtState(active);
  if (stmt) {
    const cols = activeColumns();
    const rows = activeRows();
    const fresh = computeRuleColors(getRulesFor(uri), cols, rows);
    stmt.ruleColors.clear();
    for (const [k, v] of fresh) stmt.ruleColors.set(k, v);
  }

  // Redraw all visible rows so getRowClass + the gutter cellClass
  // re-evaluate against the updated ruleColors map.
  if (gridApi) gridApi.redrawRows();

  // The format-button badge shows the rule count; update it directly so
  // the UI doesn't drift until the next full render.
  updateFormatButtonBadge(getRulesFor(uri).length);
}

function updateFormatButtonBadge(count: number): void {
  const btn = document.querySelector('.cond-fmt-btn') as HTMLButtonElement | null;
  if (!btn) return;
  let badge = btn.querySelector('.cond-fmt-badge') as HTMLSpanElement | null;
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'cond-fmt-badge';
      btn.appendChild(badge);
    }
    badge.textContent = String(count);
    btn.title = `Conditional formatting (${count} rule${count === 1 ? '' : 's'})`;
  } else {
    if (badge) badge.remove();
    btn.title = 'Conditional formatting';
  }
}

// Per-row color resolution for the current statement's rules. Rule priority
// = list order (first match wins). Rules that reference a missing column
// surface a NOT_APPLIED outcome from the evaluator, which is treated as
// "no match" for the row. The same evaluator is used in the modal's live
// preview, so they agree.
function computeRuleColors(
  rules: Rule[],
  columns: ParsedColumn[],
  rows: ParsedRow[],
): Map<number, string> {
  const out = new Map<number, string>();
  if (rules.length === 0 || rows.length === 0) return out;
  // Pre-parse each rule once. A rule whose formula doesn't parse is skipped.
  // parse() can THROW (not just return diagnostics) — e.g. a RangeError from a
  // too-deeply-nested formula — so guard it. An unparseable rule must never
  // take the whole grid render down (FORM-2).
  const parsed = rules.map((r) => {
    try {
      const { ast } = parseFormula(r.formula);
      return { rule: r, ast };
    } catch {
      return { rule: r, ast: null };
    }
  });
  // Pass the full row set + a per-render cache so COUNTIF / COUNTIFS can
  // aggregate without redoing work per row.
  const ctx = buildContext(columns, {
    allRows: rows,
    countCache: new Map<string, number>(),
  });
  // A rule whose evaluation throws (e.g. deep recursion) fails on the AST, not
  // the row data, so it would throw for every row. Retire it after the first
  // failure instead of re-throwing N times — and never let it abort the paint.
  const dead = new Set<Rule>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (const { rule, ast } of parsed) {
      if (!ast || dead.has(rule)) continue;
      try {
        const { matched } = matches(ast, row, ctx);
        if (matched) {
          out.set(i, rule.color);
          break;
        }
      } catch {
        // Treat a throw as "rule did not apply" and stop retrying it; the grid
        // still paints every other rule and row (FORM-2).
        dead.add(rule);
      }
    }
  }
  return out;
}

let gridApi: GridApi | null = null;
// Tracks which (tabKey, stmtIdx) the current `gridApi` belongs to. Set by
// mountGrid after createGrid, cleared by disposeGrid after destroy. Used
// by disposeGrid to snapshot column widths + scroll position into the
// owning PerStatementState before the grid is torn down — so editor /
// statement switches don't lose user resize + scroll work.
let mountedTabKey: string | null = null;
let mountedStmtIdx: number | null = null;
// The grid host element the current `gridApi` is mounted into. Needed by
// disposeGrid to query `.ag-body-viewport` for the vertical scrollTop —
// gridApi has no direct API for the pixel-scroll value, only an index-
// based ensureIndexVisible that misfires for unvirtualized small grids.
let mountedGridHost: HTMLElement | null = null;
// The currently-shown filter popup's capture handle (set by the filter
// component's afterGuiAttached via the onShown callback). disposeGrid uses
// it to snapshot the in-progress draft before teardown. Nulled on every
// disposeGrid since the comp it points to is destroyed there.
let activeFilter: ActiveFilterHandle | null = null;

let pickerColor: PaletteColor | null = 'yellow';
let pickerBtnFillRef: HTMLSpanElement | null = null;
let popoverRef: HTMLDivElement | null = null;
let popoverDocClickHandler: ((e: MouseEvent) => void) | null = null;
let popoverEscHandler: ((e: KeyboardEvent) => void) | null = null;

let highlightModeEnabled = false;
let highlightToggleInputRef: HTMLInputElement | null = null;
let themeBtnRef: HTMLButtonElement | null = null;
let columnsBtnRef: HTMLButtonElement | null = null;
let clearFiltersBtnRef: HTMLButtonElement | null = null;

// M11 panel zoom. Range 30–250%; +/- buttons step by 25, but the manual
// input accepts any integer in range. Hydrated from workspaceState on
// 'ready' via panel-zoom-changed. Default 100 keeps the panel byte-identical
// to M1–M10 until the user touches the zoom button.
const ZOOM_MIN = 30;
const ZOOM_MAX = 250;
const ZOOM_STEP = 25;
const ZOOM_DEFAULT = 100;
let panelZoom = ZOOM_DEFAULT;
let zoomBtnRef: HTMLButtonElement | null = null;
let zoomPopoverPctRef: HTMLInputElement | null = null;
let zoomPopoverMinusRef: HTMLButtonElement | null = null;
let zoomPopoverPlusRef: HTMLButtonElement | null = null;

function clampZoom(n: number): number {
  // Integer clamp only; no snapping to ZOOM_STEP (the manual input would
  // surprise the user if 47 became 50 on commit). +/- buttons drive the
  // 25-stepped behaviour by passing the pre-stepped value in.
  const int = Math.trunc(n);
  if (int < ZOOM_MIN) return ZOOM_MIN;
  if (int > ZOOM_MAX) return ZOOM_MAX;
  return int;
}

function applyZoomCss(): void {
  // The single CSS variable that every chrome + AG Grid sizing rule
  // multiplies through. See styles.css for the cascading calc()s.
  document.documentElement.style.setProperty('--zoom-factor', String(panelZoom / 100));
}

// Base pixel values that match the CSS defaults in styles.css. Kept in
// sync with the .ag-theme-alpine block so JS-driven zoom recomputes the
// same numbers the CSS would otherwise.
const ZOOM_BASE_ROW_HEIGHT = 24;
const ZOOM_BASE_HEADER_HEIGHT = 28;

/**
 * AG Grid caches row positions from the initial `rowHeight` / `headerHeight`
 * options and the M3 canvas auto-sizer fixes column widths at
 * `onFirstDataRendered`. Changing the CSS variables alone updates the font
 * but leaves cells the same size — text overlaps when zooming in, blank
 * space appears when zooming out. This function pokes the grid API so the
 * layout recomputes to match the new zoom factor.
 */
function applyZoomToGrid(): void {
  if (!gridApi) return;
  const factor = panelZoom / 100;

  // 1) Lower each existing column's minWidth so they can actually shrink
  //    on zoom-down. defaultColDef.minWidth was 60 at grid creation; a
  //    naked setColumnWidths(42) lands at 60 because of the floor. We
  //    rebuild col defs with a scaled minWidth and push via setGridOption
  //    — AG Grid diffs by colId and preserves sort / filter / etc. state.
  //    Gutter + nested cols (suppressAutoSize) are passed through
  //    untouched so they don't pick up the new minWidth.
  const scaledMinWidth = Math.max(20, Math.round(60 * factor));
  const currentDefs = (gridApi.getColumnDefs() ?? []) as ColDef[];
  const updatedDefs = currentDefs.map((def) => {
    if (def.suppressAutoSize) return def;
    return { ...def, minWidth: scaledMinWidth };
  });
  gridApi.setGridOption('columnDefs', updatedDefs);

  // 2) Row + header heights via the dynamic setters (CSS vars alone don't
  //    invalidate AG Grid's cached row positions).
  gridApi.setGridOption('rowHeight', Math.round(ZOOM_BASE_ROW_HEIGHT * factor));
  gridApi.setGridOption('headerHeight', Math.round(ZOOM_BASE_HEADER_HEIGHT * factor));
  gridApi.resetRowHeights();

  // 3) Re-run the M3 canvas-based column auto-sizer so widths match the
  //    new font. Pull rows out of the grid's row model — we don't keep
  //    the original ParsedRow[] in scope at this layer.
  const host = document.querySelector('.grid-host') as HTMLDivElement | null;
  if (!host) return;
  const rows: ParsedRow[] = [];
  gridApi.forEachNode((node) => {
    if (node.data) rows.push(node.data as ParsedRow);
  });
  if (rows.length > 0) sizeColumnsForContent(host, gridApi, rows);

  // 4) Row-number gutter is sized off the canvas font too, but it isn't
  //    touched by sizeColumnsForContent (suppressAutoSize). Resize it
  //    directly so the numbers stay visible at any zoom.
  const gutterWidth = computeRowNumberWidth(host, rows.length);
  const cols = gridApi.getColumns();
  if (cols) {
    for (const col of cols) {
      if (!col.getColDef().field) {
        gridApi.setColumnWidths([{ key: col.getColId(), newWidth: gutterWidth }]);
        break;
      }
    }
  }
}

function setPanelZoom(next: number, fromHost: boolean): void {
  const clamped = clampZoom(next);
  if (clamped === panelZoom && !fromHost) return;
  panelZoom = clamped;
  applyZoomCss();
  applyZoomToGrid();
  refreshZoomPopover();
  if (!fromHost) {
    post({ type: 'set-panel-zoom', zoom: clamped });
  }
}

function refreshZoomPopover(): void {
  if (zoomPopoverPctRef && document.activeElement !== zoomPopoverPctRef) {
    // Don't clobber what the user is typing — only sync the value when the
    // input is unfocused (button click, host echo, reset).
    zoomPopoverPctRef.value = String(panelZoom);
  }
  if (zoomPopoverMinusRef) zoomPopoverMinusRef.disabled = panelZoom <= ZOOM_MIN;
  if (zoomPopoverPlusRef) zoomPopoverPlusRef.disabled = panelZoom >= ZOOM_MAX;
  if (zoomBtnRef) zoomBtnRef.title = `Zoom (${panelZoom}%)`;
}

/**
 * Parse the manual-input value and commit it. Empty / malformed / out-of-
 * range input falls back to the current panelZoom (so the input snaps
 * back to a valid display). Integer-only is enforced earlier by the
 * keydown + paste handlers; this is the last-line clamp.
 */
function commitZoomInput(): void {
  if (!zoomPopoverPctRef) return;
  const raw = zoomPopoverPctRef.value.trim();
  if (raw === '') {
    zoomPopoverPctRef.value = String(panelZoom);
    return;
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    zoomPopoverPctRef.value = String(panelZoom);
    return;
  }
  setPanelZoom(parsed, /*fromHost*/ false);
  // setPanelZoom's clampZoom may have adjusted the value (e.g. user typed
  // 999 → 250). Reflect the canonical value back into the input.
  zoomPopoverPctRef.value = String(panelZoom);
}

// Workspace-wide nested render-mode default. Single-statement runs (and the
// fall-through when a multi-statement's per-stmt override is unset) read this.
let nestedRenderMode: NestedRenderMode = 'inline';

let resolvedTheme: ResolvedTheme = 'dark';
let themePreference: ThemePreference = 'system';
document.documentElement.setAttribute('data-theme', resolvedTheme);
document.body?.setAttribute('data-theme', resolvedTheme);
document.documentElement.setAttribute('data-highlight-mode', 'off');
// Set the zoom CSS variable before first render so the grid + chrome mount
// at the correct size on reload (avoids a visible 1-frame resize flash).
document.documentElement.style.setProperty('--zoom-factor', String(panelZoom / 100));

interface PaginationRefs {
  container: HTMLDivElement;
  first: HTMLButtonElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  last: HTMLButtonElement;
  indicator: HTMLSpanElement;
}
let paginationRefs: PaginationRefs | null = null;

const root = document.getElementById('root') as HTMLDivElement;

function defaultPageSize(total: number): PageSize | null {
  if (total <= 100) return null;
  if (total <= 200) return 100;
  if (total <= 1000) return 200;
  return 1000;
}

function applicablePageSizes(total: number): PageSize[] {
  if (total <= 100) return [];
  if (total <= 200) return [100, 200];
  return [100, 200, 1000];
}

function gridThemeClass(): string {
  return resolvedTheme === 'dark' ? 'ag-theme-alpine-dark' : 'ag-theme-alpine';
}

function applyTheme(resolved: ResolvedTheme): void {
  resolvedTheme = resolved;
  document.documentElement.setAttribute('data-theme', resolved);
  document.body.setAttribute('data-theme', resolved);
  const host = document.querySelector('.grid-host') as HTMLElement | null;
  if (host) {
    host.classList.remove('ag-theme-alpine', 'ag-theme-alpine-dark');
    host.classList.add(gridThemeClass());
  }
}

function getOrInitStmtState(
  state: WebviewTabState,
  idx: number,
  rowCount: number,
): PerStatementState {
  let s = state.perStatement.get(idx);
  if (!s) {
    s = {
      pageSize: defaultPageSize(rowCount),
      clickColors: new Map<number, PaletteColor>(),
      ruleColors: new Map<number, string>(),
      columnFilters: new Map<string, SheetsFilterModel>(),
      columnHighlights: new Set<string>(),
    };
    state.perStatement.set(idx, s);
  }
  return s;
}

function activeStmtState(state: WebviewTabState): PerStatementState | null {
  if (state.activeStmtIndex === null) return null;
  return state.perStatement.get(state.activeStmtIndex) ?? null;
}

function effectiveRenderMode(state: WebviewTabState): NestedRenderMode {
  const s = activeStmtState(state);
  return s?.renderMode ?? nestedRenderMode;
}

function isMultiResult(result: TabResult): boolean {
  return result.kind === 'multi';
}

function updatePaginationControls(): void {
  if (!paginationRefs || !gridApi) return;
  const total = Math.max(1, gridApi.paginationGetTotalPages());
  if (total <= 1) {
    paginationRefs.container.style.display = 'none';
    return;
  }
  paginationRefs.container.style.display = '';
  const current = gridApi.paginationGetCurrentPage();
  const onFirst = current === 0;
  const onLast = current >= total - 1;
  paginationRefs.first.disabled = onFirst;
  paginationRefs.prev.disabled = onFirst;
  paginationRefs.next.disabled = onLast;
  paginationRefs.last.disabled = onLast;
  paginationRefs.indicator.textContent = `${current + 1}/${total}`;
}

function setPickerColor(next: PaletteColor | null): void {
  pickerColor = next;
  updatePickerBtnFill();
}

function updatePickerBtnFill(): void {
  if (!pickerBtnFillRef) return;
  pickerBtnFillRef.className = pickerColor
    ? `swatch-fill color-swatch swatch-${pickerColor}`
    : 'swatch-fill color-swatch swatch-none';
}

function closePopover(): void {
  if (popoverRef && popoverRef.parentElement) {
    popoverRef.parentElement.removeChild(popoverRef);
  }
  popoverRef = null;
  // Drop refs into the (now-detached) zoom popover so a follow-up
  // refreshZoomPopover() doesn't try to mutate orphan nodes.
  zoomPopoverPctRef = null;
  zoomPopoverMinusRef = null;
  zoomPopoverPlusRef = null;
  if (popoverDocClickHandler) {
    document.removeEventListener('mousedown', popoverDocClickHandler, true);
    popoverDocClickHandler = null;
  }
  if (popoverEscHandler) {
    document.removeEventListener('keydown', popoverEscHandler, true);
    popoverEscHandler = null;
  }
}

function installEscHandler(): void {
  popoverEscHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePopover();
    }
  };
  document.addEventListener('keydown', popoverEscHandler, true);
}

function openNestedPopover(
  value: unknown,
  kind: NestedKind,
  anchor: HTMLElement,
): void {
  if (highlightModeEnabled) return;

  closePopover();
  const pop = document.createElement('div');
  pop.className = `nested-cell-popover nested-popover-${kind}`;

  if (kind === 'bytes' && typeof value === 'string') {
    const b64Header = document.createElement('div');
    b64Header.className = 'popover-section-header';
    b64Header.textContent = 'base64';
    pop.appendChild(b64Header);

    const b64Pre = document.createElement('pre');
    b64Pre.className = 'popover-pre';
    b64Pre.textContent = value;
    pop.appendChild(b64Pre);

    const hexHeader = document.createElement('div');
    hexHeader.className = 'popover-section-header';
    hexHeader.textContent = 'hex (first 64 bytes)';
    pop.appendChild(hexHeader);

    const hexPre = document.createElement('pre');
    hexPre.className = 'popover-pre';
    hexPre.textContent = bytesToHex(value, 64);
    pop.appendChild(hexPre);
  } else {
    const pre = document.createElement('pre');
    pre.className = 'popover-pre';
    try {
      pre.textContent = JSON.stringify(value, null, 2);
    } catch {
      pre.textContent = String(value);
    }
    pop.appendChild(pre);
  }

  const rect = anchor.getBoundingClientRect();
  pop.style.position = 'fixed';
  const leftClamped = Math.max(8, Math.min(rect.left, window.innerWidth - 320));
  pop.style.left = `${leftClamped}px`;
  const MAX_POPOVER_H = 480;
  const spaceBelow = window.innerHeight - rect.bottom;
  if (spaceBelow >= 200 || spaceBelow >= rect.top) {
    pop.style.top = `${rect.bottom + 4}px`;
    pop.style.maxHeight = `${Math.min(MAX_POPOVER_H, Math.max(120, spaceBelow - 16))}px`;
  } else {
    pop.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    pop.style.maxHeight = `${Math.min(MAX_POPOVER_H, Math.max(120, rect.top - 16))}px`;
  }

  document.body.appendChild(pop);
  popoverRef = pop;

  popoverDocClickHandler = (e: MouseEvent) => {
    if (!popoverRef) return;
    const target = e.target as Node | null;
    if (target && (popoverRef.contains(target) || anchor.contains(target))) return;
    closePopover();
  };
  document.addEventListener('mousedown', popoverDocClickHandler, true);
  installEscHandler();
}

function openPopover(anchor: HTMLElement, tabKey: string, stmtIdx: number): void {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'color-popover';

  // Swatches are always usable: coloring works in both modes (right-click
  // paints even when the toggle is off), so the user must be able to pick the
  // color regardless of the toggle.
  const swatchesDisabled = false;

  const makeSwatch = (color: PaletteColor | null): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `color-swatch ${color ? `swatch-${color}` : 'swatch-none'}`;
    btn.title = swatchesDisabled
      ? 'Enable highlighting first'
      : (color ?? 'None');
    if (pickerColor === color) btn.classList.add('selected');
    if (swatchesDisabled) btn.classList.add('disabled');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (swatchesDisabled) return;
      setPickerColor(color);
      closePopover();
    });
    return btn;
  };

  for (const c of PALETTE) pop.appendChild(makeSwatch(c));
  pop.appendChild(makeSwatch(null));

  const clearRow = document.createElement('div');
  clearRow.className = 'clear-all-row';
  const clearAllBtn = document.createElement('button');
  clearAllBtn.type = 'button';
  clearAllBtn.className = 'clear-all-btn';
  clearAllBtn.textContent = 'Clear all';
  const state = tabs.get(tabKey);
  const stmtState = state?.perStatement.get(stmtIdx);
  const hasHighlights = (stmtState?.clickColors.size ?? 0) > 0;
  clearAllBtn.disabled = !hasHighlights;
  clearAllBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = tabs.get(tabKey)?.perStatement.get(stmtIdx);
    if (!s || s.clickColors.size === 0) return;
    s.clickColors.clear();
    if (gridApi) gridApi.redrawRows();
    closePopover();
  });
  clearRow.appendChild(clearAllBtn);
  pop.appendChild(clearRow);

  anchor.parentElement?.appendChild(pop);
  popoverRef = pop;

  popoverDocClickHandler = (e: MouseEvent) => {
    if (!popoverRef) return;
    const target = e.target as Node | null;
    if (target && (popoverRef.contains(target) || anchor.contains(target))) return;
    closePopover();
  };
  document.addEventListener('mousedown', popoverDocClickHandler, true);
  installEscHandler();
}

function render(): void {
  // Dispose the OLD grid FIRST, while its DOM is still attached. Once
  // `root.innerHTML = ''` below detaches the grid container, calls like
  // `getHorizontalPixelRange()` and `getActualWidth()` return stale /
  // zero values — column widths and scroll position would be saved as
  // "default / origin" on every editor switch, defeating the
  // persistence in disposeGrid.
  disposeGrid();

  paginationRefs = null;
  pickerBtnFillRef = null;
  themeBtnRef = null;
  zoomBtnRef = null;
  highlightToggleInputRef = null;
  closePopover();
  // The export menu is attached to document.body (not root), so
  // root.innerHTML = '' below would orphan it but leave the module-level
  // exportMenuRef dangling — making the next click on a fresh export
  // button silently fall into the "close" branch and do nothing visible.
  closeExportMenuExternally();
  root.innerHTML = '';
  const layout = document.createElement('div');
  layout.className = 'layout';

  // Pin-mismatch cues: a sticky banner above the content + an accent border
  // around the grid (via the .pin-mismatch modifier on .content, styled in
  // styles.css). Only when the focused file differs from the pinned one.
  const mismatch = isPinMismatch();
  if (mismatch) {
    layout.appendChild(renderPinBanner());
  }
  const content = renderContent();
  if (mismatch) content.classList.add('pin-mismatch');
  layout.appendChild(content);
  root.appendChild(layout);
}

function renderContent(): HTMLElement {
  const content = document.createElement('div');
  content.className = 'content';

  const active = activeKey ? tabs.get(activeKey) : null;
  if (!active) {
    disposeGrid();
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Press Shift+Enter on a SQL selection to run a query.';
    content.appendChild(empty);
    return content;
  }

  const result = active.tab.result;

  if (result.kind === 'running') {
    disposeGrid();
    content.appendChild(renderRunningState(active.tab.key));
    return content;
  }

  if (result.kind === 'error') {
    disposeGrid();
    const banner = document.createElement('div');
    banner.className = 'error-banner';
    const pre = document.createElement('pre');
    pre.textContent = result.message;
    banner.appendChild(pre);
    content.appendChild(banner);
    return content;
  }

  if (result.kind === 'multi') {
    if (active.activeStmtIndex === null) {
      disposeGrid();
      content.appendChild(renderOverviewTable(active, result));
      return content;
    }
    // Drilled into a specific statement.
    const idx = active.activeStmtIndex;
    const outcome = result.statements[idx];
    if (!outcome) {
      // Out-of-range — fall back to overview.
      active.activeStmtIndex = null;
      disposeGrid();
      content.appendChild(renderOverviewTable(active, result));
      return content;
    }
    content.appendChild(renderStatementView(active, outcome, idx));
    return content;
  }

  // kind === 'ok' — single-statement, M6-byte-identical path.
  content.appendChild(renderSelectGrid(active, result.columns, result.rows, 0));
  return content;
}

function renderRunningState(cancelKey: string): HTMLElement {
  const loading = document.createElement('div');
  loading.className = 'loading-state';

  const spinnerRow = document.createElement('div');
  spinnerRow.className = 'spinner-row';
  const sp = document.createElement('span');
  sp.className = 'spinner';
  spinnerRow.appendChild(sp);
  const txt = document.createElement('span');
  txt.textContent = 'Running query…';
  spinnerRow.appendChild(txt);
  loading.appendChild(spinnerRow);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'cancel-btn';
  cancelBtn.textContent = 'Cancel query';
  cancelBtn.addEventListener('click', () => {
    cancelBtn.disabled = true;
    post({ type: 'cancel', key: cancelKey });
  });
  loading.appendChild(cancelBtn);

  return loading;
}

/**
 * BQ-console-inspired "All results" overview. One row per statement. Click
 * "View results" to drill into a statement; click the back link to return.
 */
function renderOverviewTable(
  active: WebviewTabState,
  result: { kind: 'multi'; statements: StatementOutcome[]; sqlPreviews: (string | null)[] },
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'multi-overview';

  // Header strip with a quick summary (Query completed / Statements: N).
  const header = document.createElement('div');
  header.className = 'multi-overview-header';
  const status = document.createElement('span');
  status.className = 'multi-overview-status';
  const overall = overallStatus(result.statements);
  status.classList.add(`status-${overall.kind}`);
  status.innerHTML = `${statusGlyphSvg(overall.kind)}<span>${overall.label}</span>`;
  header.appendChild(status);

  const summary = document.createElement('span');
  summary.className = 'multi-overview-summary';
  summary.textContent = `Statements processed: ${result.statements.length}`;
  header.appendChild(summary);
  wrap.appendChild(header);

  const tableTitle = document.createElement('div');
  tableTitle.className = 'multi-overview-title';
  tableTitle.textContent = 'All results';
  wrap.appendChild(tableTitle);

  const table = document.createElement('table');
  table.className = 'multi-overview-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of ['Status', 'Stmt', 'SQL', 'Result', 'Action']) {
    const th = document.createElement('th');
    th.textContent = col;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  result.statements.forEach((stmt, idx) => {
    const tr = document.createElement('tr');

    // Status icon
    const tdStatus = document.createElement('td');
    tdStatus.className = `status-cell status-${stmt.kind}`;
    tdStatus.innerHTML = statusGlyphSvg(stmt.kind);
    tr.appendChild(tdStatus);

    // Statement label — "[N:1]" mirrors BQ console's statement index notation.
    const tdIdx = document.createElement('td');
    tdIdx.className = 'stmt-cell';
    tdIdx.textContent = `[${idx + 1}:1]`;
    tr.appendChild(tdIdx);

    // SQL preview (best-effort, may be null).
    const tdSql = document.createElement('td');
    tdSql.className = 'sql-cell';
    const sqlText = result.sqlPreviews[idx];
    if (sqlText) {
      tdSql.textContent = truncateSql(sqlText);
      tdSql.title = sqlText;
    } else {
      tdSql.textContent = '—';
      tdSql.classList.add('sql-cell-empty');
    }
    tr.appendChild(tdSql);

    // Result summary text (rows / rows affected / succeeded / cancelled),
    // followed by a muted per-statement timing annotation `(8.1s)` when the
    // M7 child-job enrichment was able to fetch start/end times.
    const tdResult = document.createElement('td');
    tdResult.className = 'result-cell';
    tdResult.textContent = statementSummary(stmt);
    const stmtExecMs = perStatementExecutionMs(stmt);
    if (stmtExecMs !== null) {
      const annot = document.createElement('span');
      annot.className = 'stmt-time-annot';
      annot.textContent = ` (${formatExecutionTime(stmtExecMs)})`;
      tdResult.appendChild(annot);
    }
    tr.appendChild(tdResult);

    // Action — link to drill in. Cancelled / script-completed have no extra
    // detail to show, but we still allow drill-in (banner with the message).
    const tdAction = document.createElement('td');
    tdAction.className = 'action-cell';
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'view-results-link';
    link.textContent = 'View results';
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      drillIntoStatement(active, idx);
    });
    tdAction.appendChild(link);
    tr.appendChild(tdAction);

    // Whole row click also drills in (convenience).
    tr.addEventListener('click', () => drillIntoStatement(active, idx));

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  return wrap;
}

interface OverallStatus { kind: 'ok' | 'error' | 'cancelled'; label: string }

function overallStatus(statements: StatementOutcome[]): OverallStatus {
  if (statements.some((s) => s.kind === 'error')) {
    return { kind: 'error', label: 'Query failed' };
  }
  if (statements.some((s) => s.kind === 'cancelled')) {
    return { kind: 'cancelled', label: 'Query cancelled' };
  }
  return { kind: 'ok', label: 'Query completed' };
}

/**
 * Pluck the per-statement execution time off a SELECT / DML / DDL outcome,
 * or return null when absent (script-completed / error / cancelled never
 * carry one; the M7 enrichment may have failed for the run). Drives the
 * `(8.1s)` annotation in the overview Result column.
 */
function perStatementExecutionMs(stmt: StatementOutcome): number | null {
  if (stmt.kind === 'select' || stmt.kind === 'dml' || stmt.kind === 'ddl') {
    return typeof stmt.executionMs === 'number' ? stmt.executionMs : null;
  }
  return null;
}

function statementSummary(stmt: StatementOutcome): string {
  switch (stmt.kind) {
    case 'select': {
      const n = stmt.rows.length;
      if (n === 0) return '0 rows';
      return `${n.toLocaleString()} row${n === 1 ? '' : 's'}`;
    }
    case 'dml':
      return stmt.message;
    case 'ddl':
      return stmt.message;
    case 'script-completed':
      return 'Succeeded (no output)';
    case 'error':
      return 'Error';
    case 'cancelled':
      return 'Cancelled';
  }
}

function truncateSql(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= 140) return flat;
  return flat.slice(0, 137) + '…';
}

function statusGlyphSvg(kind: StatementOutcome['kind'] | OverallStatus['kind']): string {
  if (kind === 'error') {
    return `<svg class="status-glyph status-glyph-error" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5 5l6 6M11 5l-6 6" stroke="white" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  }
  if (kind === 'cancelled') {
    return `<svg class="status-glyph status-glyph-cancelled" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="3.5" y1="3.5" x2="12.5" y2="12.5" stroke="currentColor" stroke-width="1.6"/></svg>`;
  }
  // 'select' / 'dml' / 'ddl' / 'script-completed' / 'ok' all use a checkmark.
  return `<svg class="status-glyph status-glyph-ok" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.5 8.5l2.2 2.2L11.5 5.8" stroke="white" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function drillIntoStatement(active: WebviewTabState, idx: number): void {
  // Drilling in from the overview starts fresh — forget any saved cell
  // selection for this statement so re-entering it doesn't restore one. (A
  // plain file switch doesn't drill, so its restore path is unaffected.)
  const st = active.perStatement.get(idx);
  if (st) st.cellSelection = null;
  active.activeStmtIndex = idx;
  render();
  // Switching statement views forgets any selection — including a stray native
  // text-selection left by a prior Ctrl+A in another statement's grid — so a
  // CTE's status / result text never shows up highlighted on arrival.
  clearNativeSelection();
}

function backToOverview(active: WebviewTabState): void {
  active.activeStmtIndex = null;
  render();
  clearNativeSelection();
}

/**
 * Drill-in view for one statement of a multi-statement result. SELECT
 * statements render the M6 grid (with per-statement page-size, highlights,
 * render-mode override); DDL / DML / script-completed / error / cancelled
 * render as a status banner.
 */
function renderStatementView(
  active: WebviewTabState,
  stmt: StatementOutcome,
  idx: number,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'statement-view';

  // Back link is always present so the user can re-enter the overview.
  const breadcrumb = document.createElement('div');
  breadcrumb.className = 'statement-breadcrumb';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'back-link';
  back.textContent = '← All results';
  back.addEventListener('click', () => backToOverview(active));
  breadcrumb.appendChild(back);

  const label = document.createElement('span');
  label.className = 'statement-label';
  label.textContent = `Statement ${idx + 1} · ${statementSummary(stmt)}`;
  breadcrumb.appendChild(label);

  wrap.appendChild(breadcrumb);

  if (stmt.kind === 'select') {
    wrap.appendChild(renderSelectGrid(active, stmt.columns, stmt.rows, idx));
  } else {
    wrap.appendChild(renderBannerForStatement(stmt));
  }

  return wrap;
}

function renderBannerForStatement(stmt: StatementOutcome): HTMLElement {
  const banner = document.createElement('div');
  if (stmt.kind === 'error') {
    banner.className = 'error-banner';
    const pre = document.createElement('pre');
    pre.textContent = stmt.message;
    banner.appendChild(pre);
    return banner;
  }
  if (stmt.kind === 'cancelled') {
    banner.className = 'status-banner cancelled-banner';
    banner.textContent = 'This statement was cancelled.';
    return banner;
  }
  if (stmt.kind === 'dml') {
    banner.className = 'status-banner dml-banner';
    banner.textContent = `${stmt.message}.`;
    return banner;
  }
  if (stmt.kind === 'ddl') {
    banner.className = 'status-banner ddl-banner';
    banner.textContent = stmt.message;
    return banner;
  }
  if (stmt.kind === 'script-completed') {
    banner.className = 'status-banner script-banner';
    banner.textContent = stmt.message;
    return banner;
  }
  // Unreachable for 'select' — renderStatementView routes that to the grid
  // path, not here. Keep a defensive fallback so the panel never goes blank.
  banner.className = 'status-banner';
  banner.textContent = '(no displayable content)';
  return banner;
}

/**
 * Render a SELECT result grid + footer. Single-statement runs (kind: 'ok')
 * call this directly with stmtIdx=0; multi-statement drill-in calls it from
 * renderStatementView. The per-statement state (page size, highlights,
 * render-mode override) is keyed by stmtIdx so each chip preserves its own.
 */
function renderSelectGrid(
  active: WebviewTabState,
  columns: ParsedColumn[],
  rows: ParsedRow[],
  stmtIdx: number,
): HTMLElement {
  // Lazily allocate per-stmt state on first view.
  const stmt = getOrInitStmtState(active, stmtIdx, rows.length);

  if (rows.length === 0 || columns.length === 0) {
    disposeGrid();
    const notice = document.createElement('div');
    notice.className = 'empty-result';
    notice.textContent = 'Query returned 0 rows';
    return notice;
  }

  const mode = effectiveRenderMode(active);
  const view =
    mode === 'explode' ? explodeRows(columns, rows) : { columns, rows };

  const wrap = document.createElement('div');
  wrap.className = 'grid-wrap';

  const gridHost = document.createElement('div');
  // `grid-initializing` disables AG Grid's column width/position transitions
  // during mount so width restoration (applyColumnState) snaps into place
  // instead of sliding in — the class is removed one frame after reveal.
  gridHost.className = `grid-host grid-initializing ${gridThemeClass()}`;
  // Hide until first-render restoration completes, then reveal in one shot
  // (see mountGrid's onFirstDataRendered). Without this the user watches
  // the grid paint at defaults and then jump as column widths / sort /
  // page / scroll get restored across separate frames. visibility:hidden
  // (not display:none) keeps layout intact so the canvas auto-sizer and
  // scroll math still work while hidden.
  gridHost.style.visibility = 'hidden';
  wrap.appendChild(gridHost);

  const footer = document.createElement('div');
  footer.className = 'grid-footer';

  footer.appendChild(renderColorPicker(active.tab.key, stmtIdx));
  footer.appendChild(renderHighlightToggle());
  footer.appendChild(renderClearFiltersButton());

  const totalRows = view.rows.length;
  const pageSize =
    mode === 'explode' ? defaultPageSize(totalRows) : stmt.pageSize;

  if (pageSize !== null) {
    const paginationGroup = document.createElement('div');
    paginationGroup.className = 'pagination-controls';

    // User page changes drop the cell selection (the selected rows scroll out
    // of the page). Cleared here rather than in onPaginationChanged so the
    // programmatic page restore on mount doesn't wipe a restored selection.
    const firstBtn = makePagBtn('|<', 'First page', () => {
      if (gridApi) gridApi.paginationGoToFirstPage();
      clearRangeSelection();
    });
    const prevBtn = makePagBtn('<', 'Previous page', () => {
      if (gridApi) gridApi.paginationGoToPreviousPage();
      clearRangeSelection();
    });
    const indicator = document.createElement('span');
    indicator.className = 'page-indicator';
    indicator.textContent = '1/1';
    const nextBtn = makePagBtn('>', 'Next page', () => {
      if (gridApi) gridApi.paginationGoToNextPage();
      clearRangeSelection();
    });
    const lastBtn = makePagBtn('>|', 'Last page', () => {
      if (gridApi) gridApi.paginationGoToLastPage();
      clearRangeSelection();
    });

    paginationGroup.appendChild(firstBtn);
    paginationGroup.appendChild(prevBtn);
    paginationGroup.appendChild(indicator);
    paginationGroup.appendChild(nextBtn);
    paginationGroup.appendChild(lastBtn);
    footer.appendChild(paginationGroup);

    paginationRefs = {
      container: paginationGroup,
      first: firstBtn,
      prev: prevBtn,
      next: nextBtn,
      last: lastBtn,
      indicator,
    };

    const sizeGroup = document.createElement('div');
    sizeGroup.className = 'page-size-group';

    const label = document.createElement('label');
    label.setAttribute('for', 'page-size-select');
    label.textContent = 'rows:';
    sizeGroup.appendChild(label);

    const select = document.createElement('select');
    select.id = 'page-size-select';
    for (const n of applicablePageSizes(totalRows)) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = n.toLocaleString();
      if (n === pageSize) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      const next = parseInt(select.value, 10) as PageSize;
      onPageSizeChange(active.tab.key, stmtIdx, next);
    });
    sizeGroup.appendChild(select);

    footer.appendChild(sizeGroup);
  }

  if (hasNestedColumns(columns)) {
    footer.appendChild(renderRenderModeToggle(active));
  }
  footer.appendChild(
    renderConditionalFormattingButton(buildRulesCallbacks()),
  );
  // Pin toggle — immediately after the conditional-formatting button in the
  // left cluster. `active.tab.key` is the displayed result's key (the active
  // editor's file when unpinned), which is what we pin.
  footer.appendChild(renderPinButton(active.tab.key));
  // Footer-level status slot for export toasts ("Copied N rows", "Saved
  // foo.csv", "Cancelled", error). Position: absolute overlay (CSS), so it
  // doesn't disrupt the layout of the right cluster when it appears.
  const exportStatus = document.createElement('span');
  exportStatus.className = 'export-status';
  exportStatus.setAttribute('aria-live', 'polite');
  footer.appendChild(exportStatus);

  // The export + zoom + theme + clock + row-count cluster lives on the
  // RIGHT side of the footer; the format / pagination / highlight controls
  // (used much more often) stay on the left. Explicit wrapper div pushed
  // right via `margin-left: auto` — bulletproof against any flex-gap edge
  // cases that bit the earlier marker-class approach.
  const rightCluster = document.createElement('div');
  rightCluster.className = 'footer-right-cluster';
  rightCluster.appendChild(
    renderExportButton(buildExportCallbacks(active, stmtIdx, view.columns)),
  );
  rightCluster.appendChild(renderZoomButton());
  rightCluster.appendChild(renderColumnsButton());
  rightCluster.appendChild(renderThemeToggle());

  // M11 execution-time indicator. Hidden for empty / error / cancelled /
  // 0-row states via activeExecutionTiming returning null. Placed between
  // theme and row-count per spec.
  const timing = activeExecutionTiming(active);
  if (timing) {
    rightCluster.appendChild(renderExecutionTimeIndicator(timing));
  }

  const count = document.createElement('span');
  count.className = 'row-count';
  count.textContent = formatRowCount(totalRows);
  rightCluster.appendChild(count);

  footer.appendChild(rightCluster);

  wrap.appendChild(footer);

  const mountKey = active.tab.key;
  queueMicrotask(() =>
    mountGrid(gridHost, view.columns, view.rows, pageSize, mountKey, stmtIdx),
  );
  return wrap;
}

function renderColorPicker(tabKey: string, stmtIdx: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'color-picker';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'color-picker-btn';
  btn.title = 'Highlight color';

  const fill = document.createElement('span');
  fill.className = 'swatch-fill';
  btn.appendChild(fill);
  pickerBtnFillRef = fill;
  updatePickerBtnFill();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popoverRef) {
      closePopover();
    } else {
      openPopover(btn, tabKey, stmtIdx);
    }
  });

  wrap.appendChild(btn);
  return wrap;
}

function renderModeIconSvg(mode: NestedRenderMode): string {
  if (mode === 'inline') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="2.5" y="2" width="11" height="3" rx="0.5"/>
      <rect x="2.5" y="6.5" width="11" height="3" rx="0.5"/>
      <rect x="2.5" y="11" width="11" height="3" rx="0.5"/>
    </svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="12" height="10" rx="0.8"/>
    <line x1="2" y1="6.5" x2="14" y2="6.5"/>
    <line x1="2" y1="9.5" x2="14" y2="9.5"/>
    <line x1="6" y1="3" x2="6" y2="13"/>
    <line x1="10" y1="3" x2="10" y2="13"/>
  </svg>`;
}

function renderModeTooltip(mode: NestedRenderMode): string {
  if (mode === 'inline') {
    return 'Nested rendering: Inline (click to switch to Explode)';
  }
  return 'Nested rendering: Explode (click to switch to Inline)';
}

function renderRenderModeToggle(active: WebviewTabState): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'render-mode-toggle';

  const mode = effectiveRenderMode(active);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'render-mode-btn';
  btn.innerHTML = renderModeIconSvg(mode);
  btn.title = renderModeTooltip(mode);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const next: NestedRenderMode = mode === 'inline' ? 'explode' : 'inline';
    setRenderMode(active, next, /*fromHost*/ false);
  });

  wrap.appendChild(btn);
  return wrap;
}

/**
 * Toggle render mode. For single-statement results (TabResult.kind ===
 * 'ok'), this updates the workspace-wide default and persists via host —
 * matches M6's behavior. For multi-statement results drilled into a
 * statement, this sets the per-statement override only; the workspace
 * default is unchanged, and each chip keeps its own mode. Either way,
 * highlights on the current statement are cleared because __rowId doesn't
 * map between inline and explode views.
 */
function setRenderMode(
  active: WebviewTabState,
  next: NestedRenderMode,
  fromHost: boolean,
): void {
  const isMulti = isMultiResult(active.tab.result) && active.activeStmtIndex !== null;
  if (isMulti) {
    const stmt = activeStmtState(active);
    if (!stmt) return;
    if ((stmt.renderMode ?? nestedRenderMode) === next) return;
    stmt.renderMode = next;
    stmt.clickColors.clear();
    // M12: column-header highlights also clear because the column set
    // changes (inline ↔ explode rebuilds dotted fields). Matches the M9
    // filter-clear policy for disappeared columns — simpler than trying
    // to map highlights between the two views.
    stmt.columnHighlights.clear();
    // Multi-statement overrides are ephemeral — don't persist or echo
    // to host (would clobber the workspace default for other files).
    render();
    return;
  }

  // Single-statement / 'ok' result: workspace-wide change, M6 semantics.
  if (next === nestedRenderMode) return;
  nestedRenderMode = next;
  for (const state of tabs.values()) {
    // Single-stmt case: only the index-0 perStatement entry has highlights.
    const s = state.perStatement.get(0);
    s?.clickColors.clear();
    s?.columnHighlights.clear();
  }
  if (!fromHost) {
    post({ type: 'set-render-mode', mode: next });
  }
  render();
}

function renderHighlightToggle(): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'highlight-toggle';
  wrap.title = 'Highlighting mode — click rows to color them';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'highlight-toggle-input';
  input.checked = highlightModeEnabled;
  input.addEventListener('change', () => {
    const next = input.checked;
    if (next === highlightModeEnabled) return;
    highlightModeEnabled = next;
    post({ type: 'set-highlight-mode', enabled: next });
    applyHighlightModeAttr();
    // Entering paint mode (or leaving it) drops any cell-range selection so a
    // stale highlight doesn't linger from the other mode.
    clearRangeSelection();
  });
  highlightToggleInputRef = input;

  const track = document.createElement('span');
  track.className = 'highlight-toggle-track';
  const thumb = document.createElement('span');
  thumb.className = 'highlight-toggle-thumb';
  track.appendChild(thumb);

  wrap.appendChild(input);
  wrap.appendChild(track);
  return wrap;
}

function applyHighlightModeAttr(): void {
  document.documentElement.setAttribute(
    'data-highlight-mode',
    highlightModeEnabled ? 'on' : 'off',
  );
}

/**
 * Footer "clear all filters" button. Funnel-with-diagonal-slash glyph,
 * hidden by default. Made visible by updateClearFiltersButton() whenever
 * the grid has at least one active column filter; clicking it sends
 * setFilterModel(null) which clears them all in one shot.
 */
function renderClearFiltersButton(): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'clear-filters-btn hidden';
  btn.title = 'Clear all filters';
  btn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M1 3l5 6v4l4 1V9l5-6z" fill="currentColor"/>' +
    '<line x1="2" y1="14" x2="14" y2="2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '</svg>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!gridApi) return;
    gridApi.setFilterModel(null);
  });
  clearFiltersBtnRef = btn;
  // Set the correct initial visibility based on whatever filter state
  // the grid (if any) currently carries. updateClearFiltersButton handles
  // the gridApi-is-null case → hidden.
  updateClearFiltersButton();
  return btn;
}

function updateClearFiltersButton(): void {
  if (!clearFiltersBtnRef) return;
  let hasAnyFilter = false;
  if (gridApi) {
    const model = gridApi.getFilterModel();
    hasAnyFilter = !!model && Object.keys(model).length > 0;
  }
  clearFiltersBtnRef.classList.toggle('hidden', !hasAnyFilter);
}

// Tilted-pushpin silhouette (Bootstrap Icons `pin-angle-fill`), reused for
// both states. The codicon font isn't bundled in the webview, so we ship the
// glyph as inline SVG like every other footer icon. currentColor → theme-
// aware; the unpinned variant strokes the outline (subdued), the pinned
// variant fills it (amber accent via the .pinned class in styles.css).
const PIN_ANGLE_PATH =
  'M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a6 6 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707s.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a6 6 0 0 1 1.013.16l3.134-3.133a3 3 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146';

// Unpinned: outlined, low-attention (subdued footer-fg via CSS).
function pinIconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" aria-hidden="true"><path d="${PIN_ANGLE_PATH}"/></svg>`;
}

// Pinned: filled, colorful (amber accent via .pinned class).
function pinnedIconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="${PIN_ANGLE_PATH}"/></svg>`;
}

/**
 * Footer pin toggle. Three visual states (spec):
 *   - unpinned → neutral outline glyph, subdued, "Pin this result".
 *   - pinned   → accent-colored filled glyph, "Pinned: <file> (click to unpin)".
 * The distinguishing cue between "pinned & viewing the pinned file" vs
 * "pinned & viewing another file" is the banner + border, NOT the icon — the
 * icon is identical for both pinned sub-states (spec hard constraint).
 *
 * Only ever rendered inside a SELECT grid's footer, which means a pinnable
 * (successful, > 0-row) result is on screen — so "no current result → no-op"
 * is satisfied structurally: the button doesn't exist for empty / loading /
 * error / 0-row / overview states.
 *
 * `displayedTabKey` is the key whose footer this is — when unpinned that is
 * the active editor's result, which is exactly what we pin.
 */
function renderPinButton(displayedTabKey: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pin-toggle';

  const btn = document.createElement('button');
  btn.type = 'button';
  const isPinned = pinnedUri !== null;
  btn.className = isPinned ? 'pin-toggle-btn pinned' : 'pin-toggle-btn';
  btn.innerHTML = isPinned ? pinnedIconSvg() : pinIconSvg();
  btn.title = isPinned
    ? `Pinned: ${basenameWithExt(pinnedUri as string)} (click to unpin)`
    : 'Pin this result';

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Pin NEVER triggers a query — pure state toggle.
    const prevActiveKey = activeKey;
    if (pinnedUri !== null) {
      pinnedUri = null;
    } else {
      pinnedUri = displayedTabKey;
    }
    recomputeActiveKey();
    // If the displayed result is unchanged (pinning/unpinning while viewing
    // the same file), only refresh the cosmetic cues — don't re-mount the
    // grid. A full render is needed only when unpinning flips the panel back
    // to a different file's result.
    if (activeKey === prevActiveKey) {
      updatePinCues();
    } else {
      render();
    }
    // Unpinning can flip the panel to a different file — hide/restore the CF
    // rule modal to match whatever result is now displayed.
    syncRuleModalToActiveKey(buildRulesCallbacks());
  });

  wrap.appendChild(btn);
  return wrap;
}

/**
 * Sticky mismatch banner. Shown above the grid only when isPinMismatch() is
 * true (pin set + focused file differs from pinned). Wording adapts: when a
 * different .sql file is focused we name it; otherwise (non-.sql / no editor)
 * we just state which file is pinned. Not dismissible — clearing it means
 * unpinning or running a new query.
 */
function pinBannerText(): string {
  const pinnedBase = basenameWithExt(pinnedUri as string);
  if (activeEditorKey && activeEditorKey !== pinnedUri) {
    return `📌 Showing pinned result from ${pinnedBase} — currently editing ${basenameWithExt(activeEditorKey)}`;
  }
  return `📌 Showing pinned result from ${pinnedBase}`;
}

function renderPinBanner(): HTMLElement {
  const banner = document.createElement('div');
  banner.className = 'pin-banner';
  const span = document.createElement('span');
  span.className = 'pin-banner-text';
  span.textContent = pinBannerText();
  banner.appendChild(span);
  return banner;
}

/**
 * Lightweight pin-state refresh — updates ONLY the footer pin icon/tooltip,
 * the mismatch banner, and the accent border, leaving the mounted grid
 * untouched. Used when a pin/unpin or an editor-focus change does NOT change
 * which result is displayed (e.g. pinning while viewing the pinned file, or
 * switching focus while pinned). Avoids the ~0.5–1s full grid re-mount that
 * a render() would incur for a purely cosmetic change.
 */
function updatePinCues(): void {
  // 1. Pin button icon + tooltip (present only when a grid footer is shown).
  const btn = document.querySelector('.pin-toggle-btn') as HTMLButtonElement | null;
  if (btn) {
    const isPinned = pinnedUri !== null;
    btn.className = isPinned ? 'pin-toggle-btn pinned' : 'pin-toggle-btn';
    btn.innerHTML = isPinned ? pinnedIconSvg() : pinIconSvg();
    btn.title = isPinned
      ? `Pinned: ${basenameWithExt(pinnedUri as string)} (click to unpin)`
      : 'Pin this result';
  }
  // 2. Banner + accent border, added/removed/updated in place.
  const layout = root.querySelector('.layout') as HTMLElement | null;
  const content = root.querySelector('.content') as HTMLElement | null;
  if (!layout || !content) return;
  const mismatch = isPinMismatch();
  const existingBanner = layout.querySelector('.pin-banner');
  if (mismatch) {
    if (!existingBanner) {
      layout.insertBefore(renderPinBanner(), content);
    } else {
      const span = existingBanner.querySelector('.pin-banner-text');
      if (span) span.textContent = pinBannerText();
    }
    content.classList.add('pin-mismatch');
  } else {
    if (existingBanner) existingBanner.remove();
    content.classList.remove('pin-mismatch');
  }
}

function zoomIconSvg(): string {
  // "Aa" glyph — easily read as a text-scale control. SVG so it inherits
  // currentColor (theme-aware) without an extra CSS file.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
    <text x="0.5" y="11.5" font-family="-apple-system, Segoe UI, sans-serif" font-size="9" font-weight="700">A</text>
    <text x="8" y="11.5" font-family="-apple-system, Segoe UI, sans-serif" font-size="6.5" font-weight="600">a</text>
  </svg>`;
}

function renderZoomButton(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'zoom-toggle';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'zoom-toggle-btn';
  btn.innerHTML = zoomIconSvg();
  btn.title = `Zoom (${panelZoom}%)`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popoverRef) {
      closePopover();
    } else {
      openZoomPopover(btn);
    }
  });
  zoomBtnRef = btn;
  wrap.appendChild(btn);
  return wrap;
}

function openZoomPopover(anchor: HTMLElement): void {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'zoom-popover';

  // Row 1: − / pct / +
  const row = document.createElement('div');
  row.className = 'zoom-popover-row';

  const minus = document.createElement('button');
  minus.type = 'button';
  minus.className = 'zoom-step-btn';
  minus.textContent = '−';
  minus.title = 'Zoom out';
  minus.addEventListener('click', (e) => {
    e.stopPropagation();
    setPanelZoom(panelZoom - ZOOM_STEP, /*fromHost*/ false);
  });
  row.appendChild(minus);
  zoomPopoverMinusRef = minus;

  const pct = document.createElement('input');
  pct.type = 'text';
  pct.className = 'zoom-popover-pct';
  pct.value = String(panelZoom);
  pct.inputMode = 'numeric';
  pct.setAttribute('aria-label', 'Zoom percentage');
  pct.maxLength = 3;
  pct.spellcheck = false;
  pct.autocomplete = 'off';
  // Select-all on focus so the user can immediately overwrite.
  pct.addEventListener('focus', () => {
    pct.select();
  });
  // Block any keystroke that would introduce a non-digit character. We
  // explicitly allow the editing/nav keys plus Enter (commit) and Escape
  // (cancel). Pasted text is filtered by the 'paste' handler below.
  pct.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitZoomInput();
      closePopover();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      pct.value = String(panelZoom);
      closePopover();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return; // allow Ctrl+A, Ctrl+C, etc.
    if (
      e.key === 'Backspace' ||
      e.key === 'Delete' ||
      e.key === 'Tab' ||
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' ||
      e.key === 'Home' ||
      e.key === 'End'
    ) {
      return;
    }
    // Single-char keys that aren't digits get blocked. This stops '.', '-',
    // '+', 'e', whitespace, etc. from ever reaching the value.
    if (e.key.length === 1 && !/[0-9]/.test(e.key)) {
      e.preventDefault();
    }
  });
  pct.addEventListener('paste', (e) => {
    const data = e.clipboardData?.getData('text') ?? '';
    if (!/^\d+$/.test(data)) {
      e.preventDefault();
    }
  });
  // Block the bubble-up so the popover's outside-click handler doesn't
  // see the click on the input and close us.
  pct.addEventListener('mousedown', (e) => e.stopPropagation());
  // Commit on blur in case the user clicks away without pressing Enter.
  pct.addEventListener('blur', () => {
    commitZoomInput();
  });
  row.appendChild(pct);
  zoomPopoverPctRef = pct;

  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'zoom-step-btn';
  plus.textContent = '+';
  plus.title = 'Zoom in';
  plus.addEventListener('click', (e) => {
    e.stopPropagation();
    setPanelZoom(panelZoom + ZOOM_STEP, /*fromHost*/ false);
  });
  row.appendChild(plus);
  zoomPopoverPlusRef = plus;

  pop.appendChild(row);

  // Row 2: Reset to 100%
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'zoom-reset-btn';
  reset.textContent = 'Reset';
  reset.title = 'Reset to 100%';
  reset.addEventListener('click', (e) => {
    e.stopPropagation();
    setPanelZoom(ZOOM_DEFAULT, /*fromHost*/ false);
  });
  pop.appendChild(reset);

  refreshZoomPopover();

  anchor.parentElement?.appendChild(pop);
  popoverRef = pop;

  // Wipe the popover refs when the popover closes (otherwise refreshZoomPopover
  // would touch detached DOM after a Reset click that the user follows up
  // with closing the popover).
  const origClose = closePopover;
  void origClose;

  popoverDocClickHandler = (e: MouseEvent) => {
    if (!popoverRef) return;
    const target = e.target as Node | null;
    if (target && (popoverRef.contains(target) || anchor.contains(target))) return;
    closePopover();
  };
  document.addEventListener('mousedown', popoverDocClickHandler, true);
  installEscHandler();
}

function themeIconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="6.5" cy="8" r="2.5"/>
    <path d="M6.5 2.5v1M6.5 12.5v1M2 8h1M10 8h1M3.3 4.8l.7.7M9 11.5l.7.7M3.3 11.2l.7-.7M9 4.5l.7-.7"/>
    <path d="M10.5 4a4 4 0 1 0 3.5 6.5A4.5 4.5 0 0 1 10.5 4z" fill="currentColor" stroke="none"/>
  </svg>`;
}

function themeTooltip(): string {
  const labels: Record<ThemePreference, string> = {
    system: 'System',
    light: 'Light',
    dark: 'Dark',
  };
  return `Theme: ${labels[themePreference]}`;
}

function renderThemeToggle(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'theme-toggle';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'theme-toggle-btn';
  btn.innerHTML = themeIconSvg();
  btn.title = themeTooltip();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popoverRef) {
      closePopover();
    } else {
      openThemePopover(btn);
    }
  });
  themeBtnRef = btn;

  wrap.appendChild(btn);
  return wrap;
}

function openThemePopover(anchor: HTMLElement): void {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'theme-popover';

  const options: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  for (const o of options) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'theme-option';
    if (o.value === themePreference) item.classList.add('selected');

    const check = document.createElement('span');
    check.className = 'theme-check';
    check.textContent = o.value === themePreference ? '✓' : '';
    item.appendChild(check);

    const labelEl = document.createElement('span');
    labelEl.textContent = o.label;
    item.appendChild(labelEl);

    item.addEventListener('click', (e) => {
      e.stopPropagation();
      themePreference = o.value;
      if (themeBtnRef) themeBtnRef.title = themeTooltip();
      post({ type: 'set-theme-preference', preference: o.value });
      closePopover();
    });
    pop.appendChild(item);
  }

  anchor.parentElement?.appendChild(pop);
  popoverRef = pop;

  popoverDocClickHandler = (e: MouseEvent) => {
    if (!popoverRef) return;
    const target = e.target as Node | null;
    if (target && (popoverRef.contains(target) || anchor.contains(target))) return;
    closePopover();
  };
  document.addEventListener('mousedown', popoverDocClickHandler, true);
  installEscHandler();
}

type ColumnsVisibilityState = 'all' | 'mixed' | 'none';

function columnsIconSvg(state: ColumnsVisibilityState): string {
  // Owl-chibi: round bell-shaped body, two big circular eyes with shine
  // highlights, small triangular beak. Reads as "looking" / visibility
  // without the creepy stare of a literal eye.
  // Slash overlay is state-driven:
  //   - all    → no overlay (owl looking around, all columns visible)
  //   - mixed  → dashed semi-transparent line (some columns hidden)
  //   - none   → thick solid line (every column hidden, prominent warning)
  const owl =
    '<path d="M4 5.5 Q 4 3 8 3 Q 12 3 12 5.5 L 12 11 Q 12 13 8 13 Q 4 13 4 11 Z" stroke-width="1.1"/>' +
    '<circle cx="6.4" cy="7" r="1.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="9.6" cy="7" r="1.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="6.8" cy="6.6" r="0.4" style="fill: var(--theme-bg)" stroke="none"/>' +
    '<circle cx="10" cy="6.6" r="0.4" style="fill: var(--theme-bg)" stroke="none"/>' +
    '<path d="M7.3 9.2 L 8 10.3 L 8.7 9.2 Z" fill="currentColor" stroke="none"/>';
  let overlay = '';
  if (state === 'mixed') {
    overlay =
      '<line x1="2.5" y1="13.5" x2="13.5" y2="2.5" stroke-width="1.3" ' +
      'stroke-dasharray="2 1.6" opacity="0.65"/>';
  } else if (state === 'none') {
    overlay =
      '<line x1="2.5" y1="13.5" x2="13.5" y2="2.5" stroke-width="1.8"/>';
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" ' +
    'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true">' +
    owl +
    overlay +
    '</svg>'
  );
}

function columnsVisibilityState(): ColumnsVisibilityState {
  if (!gridApi) return 'all';
  const dataCols = (gridApi.getColumns() ?? []).filter((c) => !isGutterCol(c));
  if (dataCols.length === 0) return 'all';
  let visibleCount = 0;
  for (const c of dataCols) if (c.isVisible()) visibleCount++;
  if (visibleCount === dataCols.length) return 'all';
  if (visibleCount === 0) return 'none';
  return 'mixed';
}

function updateColumnsIcon(): void {
  if (!columnsBtnRef) return;
  const state = columnsVisibilityState();
  columnsBtnRef.innerHTML = columnsIconSvg(state);
  columnsBtnRef.title =
    state === 'all'
      ? 'Show / hide columns (all shown)'
      : state === 'none'
      ? 'Show / hide columns (all hidden)'
      : 'Show / hide columns (some hidden)';
}

function renderColumnsButton(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'columns-toggle';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'columns-toggle-btn';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popoverRef) {
      closePopover();
    } else {
      openColumnsPopover(btn);
    }
  });
  columnsBtnRef = btn;
  // Paint the initial state now (gridApi may be null pre-mount; resolves
  // to 'all', which is correct for a fresh result). Re-evaluated on every
  // column-visibility change via onColumnVisible in mountGrid().
  updateColumnsIcon();
  wrap.appendChild(btn);
  return wrap;
}

function openColumnsPopover(anchor: HTMLElement): void {
  closePopover();
  if (!gridApi) return;

  const pop = document.createElement('div');
  pop.className = 'columns-popover';

  // Top row: "Show all" — un-hides every data column at once. Useful escape
  // hatch after a drag-to-hide spree without losing column order/widths the
  // way AG Grid's "Reset Columns" would.
  const showAll = document.createElement('button');
  showAll.type = 'button';
  showAll.className = 'columns-show-all';
  showAll.textContent = 'Show all';
  showAll.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!gridApi) return;
    const allDataColIds = (gridApi.getColumns() ?? [])
      .filter((c) => !isGutterCol(c))
      .map((c) => c.getColId());
    gridApi.setColumnsVisible(allDataColIds, true);
    refreshColumnsPopoverRows(pop);
    updateColumnsIcon();
  });
  pop.appendChild(showAll);

  // Scrollable list of one row per data column.
  const list = document.createElement('div');
  list.className = 'columns-list';
  pop.appendChild(list);
  fillColumnsPopoverList(list);

  anchor.parentElement?.appendChild(pop);
  popoverRef = pop;

  popoverDocClickHandler = (e: MouseEvent) => {
    if (!popoverRef) return;
    const target = e.target as Node | null;
    if (target && (popoverRef.contains(target) || anchor.contains(target))) return;
    closePopover();
  };
  document.addEventListener('mousedown', popoverDocClickHandler, true);
  installEscHandler();
}

function isGutterCol(c: Column): boolean {
  // Row-number gutter has an empty headerName, lockPosition: 'left', and
  // suppressMovable: true. Checking headerName is sufficient — no real
  // SQL column ever has an empty header.
  const def = c.getColDef();
  return (def.headerName ?? '') === '' && def.lockPosition === 'left';
}

// ---------------------------------------------------------------------------
// Sheets/Excel-style cell range selection (active ONLY when the color /
// highlight toggle is OFF; in color-ON mode the grid stays in click-to-paint
// mode and every handler here no-ops).
//
// AG Grid Community has no native range selection (that's an Enterprise
// feature), so this is a custom implementation:
//   • mouse-drag or shift-click selects a rectangular block of cells
//   • the block highlights the CELL, not its text — in-cell text selection is
//     disabled in this mode (enableCellTextSelection:false + cursor:cell)
//   • Ctrl/Cmd+C copies the block as TSV (pastes cleanly into Sheets/Excel)
//
// The highlight is driven by a cellClassRule (re-evaluated whenever a cell
// renders) rather than by tagging live DOM nodes, so it survives AG Grid's
// row virtualization — scrolling a selected cell out and back keeps it lit.
// Selection is keyed by *displayed* row index + colId, so it is cleared on
// sort / filter / pagination changes (those remap displayed row indices).
// ---------------------------------------------------------------------------
interface CellPos {
  rowIndex: number;
  colId: string;
}
let rangeAnchor: CellPos | null = null;
let rangeHead: CellPos | null = null;
let isDraggingRange = false;
// Derived from anchor+head; read by the cellClassRule on every cell render.
// selRowMin < 0 means "no selection".
let selRowMin = -1;
let selRowMax = -1;
const selColIds = new Set<string>();
let rangeRefreshQueued = false;
// Double-click text-selection: a read-only <input> overlay placed over the cell
// so its FULL value can be selected / copied — long values scroll horizontally
// as you drag (the cell itself clips with an ellipsis and can't). Read-only —
// this is an analysis tool, no editing. Ephemeral; never persisted.
let textModeInput: HTMLInputElement | null = null;

// --- Paint drag (M5 click-color, multi-row) --------------------------------
// Ctrl+drag in any mode, or a plain left-drag when the color toggle is ON,
// paints a contiguous range of rows. The range is inverted against the colors
// as they were BEFORE the drag (a snapshot), so dragging back up restores rows
// that leave the range — exactly like a shift range-selection. Binary invert:
// any colored row in range -> uncolored; uncolored -> the current picker color.
// A press with no drag falls back to the single-row toggle (paintRow), so a
// plain click still recolors a differently-colored row to the picker.
let paintDragActive = false;
let paintAnchorIndex = -1;
let paintDragMoved = false;
let paintSnapshot: Map<number, PaletteColor> | null = null;
let paintRangeMin = -1;
let paintRangeMax = -1;

function isCellSelected(rowIndex: number, colId: string): boolean {
  if (highlightModeEnabled) return false;
  if (selRowMin < 0) return false;
  return rowIndex >= selRowMin && rowIndex <= selRowMax && selColIds.has(colId);
}

// The active cell (selection anchor) — the keyboard cursor. Styled with a
// border via .sf-cell-active so it always reads as part of the selection.
function isActiveCell(rowIndex: number, colId: string): boolean {
  if (highlightModeEnabled || !rangeAnchor) return false;
  return rangeAnchor.rowIndex === rowIndex && rangeAnchor.colId === colId;
}

// Recompute the derived rectangle (row span + the set of colIds it covers)
// from the current anchor/head, honoring the live column order and skipping
// the pinned row-number gutter.
function recomputeRangeDerived(): void {
  selColIds.clear();
  selRowMin = -1;
  selRowMax = -1;
  if (!rangeAnchor || !rangeHead || !gridApi) return;
  selRowMin = Math.min(rangeAnchor.rowIndex, rangeHead.rowIndex);
  selRowMax = Math.max(rangeAnchor.rowIndex, rangeHead.rowIndex);
  const cols = gridApi.getAllDisplayedColumns().filter((c) => !isGutterCol(c));
  const ai = cols.findIndex((c) => c.getColId() === rangeAnchor!.colId);
  const hi = cols.findIndex((c) => c.getColId() === rangeHead!.colId);
  if (ai === -1 || hi === -1) {
    selRowMin = -1;
    selRowMax = -1;
    return;
  }
  const lo = Math.min(ai, hi);
  const hh = Math.max(ai, hi);
  for (let i = lo; i <= hh; i++) selColIds.add(cols[i].getColId());
}

// Coalesce highlight refreshes to one per animation frame so a fast drag
// (many cellMouseOver events) triggers at most one refreshCells per paint.
function scheduleRangeRefresh(): void {
  if (rangeRefreshQueued) return;
  rangeRefreshQueued = true;
  requestAnimationFrame(() => {
    rangeRefreshQueued = false;
    recomputeRangeDerived();
    // force:true is required so the cellClassRule re-runs on cells whose
    // value didn't change — that's how .sf-cell-selected is added/removed as
    // the rectangle grows/shrinks. Cost is viewport-bounded (visible cells).
    gridApi?.refreshCells({ force: true });
  });
}

function resetRangeSelectionState(): void {
  rangeAnchor = null;
  rangeHead = null;
  isDraggingRange = false;
  selRowMin = -1;
  selRowMax = -1;
  selColIds.clear();
  exitTextMode();
}

function clearRangeSelection(): void {
  if (!rangeAnchor && !rangeHead && selRowMin < 0 && !textModeInput) return;
  resetRangeSelectionState();
  scheduleRangeRefresh();
}

// Grid-option callbacks (wired into mountGrid's options).
function onRangeCellMouseDown(e: CellMouseDownEvent): void {
  const me = e.event as MouseEvent | null | undefined;
  if (me && me.button !== 0) return; // left button only
  // Paint drag: Ctrl/Cmd+drag in any mode, or a plain drag when the color
  // toggle is ON. Works on any cell, including the gutter. The single-row
  // toggle / range invert happens on move + mouseup (start/apply/endPaintDrag).
  const ctrl = !!(me && (me.ctrlKey || me.metaKey));
  if (ctrl || highlightModeEnabled) {
    if (e.rowIndex != null) startPaintDrag(e.rowIndex);
    return;
  }
  // Row-number gutter → select the whole row (shift+click extends the range).
  if (isGutterCol(e.column)) {
    if (e.rowIndex != null) selectFullRow(e.rowIndex, !!me?.shiftKey);
    else clearRangeSelection();
    return;
  }
  if (e.rowIndex == null) return;
  const pos: CellPos = { rowIndex: e.rowIndex, colId: e.column.getColId() };
  if (me?.shiftKey && rangeAnchor) {
    rangeHead = pos; // extend the rectangle from the existing anchor
  } else {
    rangeAnchor = pos;
    rangeHead = pos;
  }
  isDraggingRange = true; // cleared on document mouseup
  scheduleRangeRefresh();
}

function onRangeCellMouseOver(e: CellMouseOverEvent): void {
  // Paint drag owns the gesture while active (works over any column incl. the
  // gutter; tracked purely by row index).
  if (paintDragActive) {
    if (e.rowIndex == null) return;
    if (e.rowIndex !== paintAnchorIndex) paintDragMoved = true;
    if (paintDragMoved) applyPaintRange(e.rowIndex);
    return;
  }
  if (!isDraggingRange || highlightModeEnabled) return;
  if (isGutterCol(e.column) || e.rowIndex == null) return;
  rangeHead = { rowIndex: e.rowIndex, colId: e.column.getColId() };
  scheduleRangeRefresh();
}

// Double-click a data cell to read/copy its FULL value: opens a read-only input
// overlay sized over the cell. Long values scroll horizontally as you drag-
// select (the cell clips with an ellipsis and can't). Exits on Esc, blur
// (clicking anywhere else), grid scroll, sort / filter / page change, or
// switching files. Nested cells keep their own popover instead.
function onRangeCellDoubleClicked(e: CellDoubleClickedEvent): void {
  if (highlightModeEnabled) return;
  if (isGutterCol(e.column)) return;
  const target = e.event?.target as HTMLElement | null;
  const cellEl = target?.closest<HTMLElement>('.ag-cell');
  // Nested cells (array / struct / json / bytes) open their full-value popover
  // on double-click — mirrors the single-click affordance and keeps
  // "double-click = reveal full value" consistent with plain cells' text overlay.
  if (e.column.getColDef().cellClass === 'nested-cell') {
    const kind = e.column.getColDef().cellRendererParams?.nestedKind as
      | NestedKind
      | undefined;
    if (kind && cellEl) openNestedPopover(e.value, kind, cellEl);
    return;
  }
  if (cellEl) enterTextMode(cellEl);
}

function enterTextMode(cellEl: HTMLElement): void {
  clearRangeSelection(); // drop any block selection (and close a prior overlay)
  const rect = cellEl.getBoundingClientRect();
  const cs = window.getComputedStyle(cellEl);

  // A read-only input gives native horizontal scroll + select/copy for the full
  // value (incl. the clipped part), which a clipped cell can't. Mounted on
  // <body> so it isn't clipped by the grid; positioned over the cell via fixed
  // coords. Closes on grid scroll (it wouldn't track the moving cell).
  const input = document.createElement('input');
  input.type = 'text';
  input.readOnly = true;
  input.value = cellEl.textContent ?? '';
  input.className = 'sf-cell-text-overlay';
  input.style.left = `${rect.left}px`;
  input.style.top = `${rect.top}px`;
  input.style.width = `${rect.width}px`;
  input.style.height = `${rect.height}px`;
  input.style.fontFamily = cs.fontFamily;
  input.style.fontSize = cs.fontSize;
  input.style.fontWeight = cs.fontWeight;
  input.style.paddingLeft = cs.paddingLeft;
  input.style.paddingRight = cs.paddingRight;
  input.style.color = cs.color;
  input.addEventListener('blur', () => exitTextMode());
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      exitTextMode();
    }
  });
  document.body.appendChild(input);
  textModeInput = input;
  input.focus();
  input.select(); // full value selected up front; drag re-selects any substring
}

function exitTextMode(): void {
  const input = textModeInput;
  if (!input) return;
  textModeInput = null;
  input.remove();
}

// Displayed data columns in display order, gutter excluded — the column axis
// for keyboard navigation and Ctrl+A.
function displayedDataCols(api: GridApi): Column[] {
  return api.getAllDisplayedColumns().filter((c) => !isGutterCol(c));
}

// Row-index bounds of the CURRENT pagination page. Keyboard nav and Ctrl+A
// stay within these — each page is treated as its own "sheet" (the per-page
// result model; cross-page selection is intentionally not supported).
function pageRowBounds(api: GridApi): { first: number; last: number } {
  const total = api.getDisplayedRowCount();
  if (total === 0) return { first: 0, last: -1 };
  try {
    const size = api.paginationGetPageSize();
    if (!size || size <= 0 || size >= total) return { first: 0, last: total - 1 };
    const first = api.paginationGetCurrentPage() * size;
    return { first, last: Math.min(first + size - 1, total - 1) };
  } catch {
    return { first: 0, last: total - 1 };
  }
}

// Keyboard navigation, Sheets/Excel-style. dRow/dCol are -1/0/+1.
//   plain arrow      → move the active cell, collapse selection onto it
//   shift+arrow      → extend the selection by one cell from the anchor
//   ctrl/cmd+arrow   → jump the active cell to the page edge, collapse
//   ctrl/cmd+shift+arrow → extend the selection to the page edge
// Everything is clamped to the current page (first..last, 0..lastCol).
function moveActiveCell(e: KeyboardEvent, dRow: number, dCol: number): void {
  if (!gridApi || !rangeAnchor) return;
  const api = gridApi;
  const cols = displayedDataCols(api);
  if (cols.length === 0) return;
  const { first, last } = pageRowBounds(api);
  if (last < first) return;
  const extend = e.shiftKey;
  const toEdge = e.ctrlKey || e.metaKey;
  // Extending moves the free end (head); otherwise we move the active cell.
  const ref = extend ? rangeHead ?? rangeAnchor : rangeAnchor;
  const colIdx = cols.findIndex((c) => c.getColId() === ref.colId);
  if (colIdx === -1) return;

  let nextRow = ref.rowIndex;
  if (dRow > 0) nextRow = toEdge ? last : Math.min(last, ref.rowIndex + 1);
  else if (dRow < 0) nextRow = toEdge ? first : Math.max(first, ref.rowIndex - 1);

  let nextColIdx = colIdx;
  const lastCol = cols.length - 1;
  if (dCol > 0) nextColIdx = toEdge ? lastCol : Math.min(lastCol, colIdx + 1);
  else if (dCol < 0) nextColIdx = toEdge ? 0 : Math.max(0, colIdx - 1);
  const nextColId = cols[nextColIdx].getColId();

  if (extend) {
    rangeHead = { rowIndex: nextRow, colId: nextColId };
  } else {
    rangeAnchor = { rowIndex: nextRow, colId: nextColId };
    rangeHead = { rowIndex: nextRow, colId: nextColId };
  }
  // Keep the moved end in view. When EXTENDING (shift), scroll only the axis the
  // head actually moved on — extending columns must not jump the vertical scroll
  // (a full-column selection's head sits on the last row), and vice versa. When
  // COLLAPSING/moving (plain arrow), the active cell can land far from the
  // current view (the anchor may be off-screen after a prior extension), so
  // bring it fully into view on BOTH axes.
  try {
    if (extend) {
      if (dRow !== 0) api.ensureIndexVisible(nextRow);
      if (dCol !== 0) api.ensureColumnVisible(nextColId);
    } else {
      api.ensureIndexVisible(nextRow);
      api.ensureColumnVisible(nextColId);
    }
  } catch {
    // ensureIndexVisible can misfire on tiny unvirtualized grids — harmless.
  }
  scheduleRangeRefresh();
  e.preventDefault();
}

// Ctrl/Cmd+A — select every cell on the current page (anchor = top-left).
function selectAllOnPage(): void {
  if (!gridApi) return;
  const api = gridApi;
  const cols = displayedDataCols(api);
  if (cols.length === 0) return;
  const { first, last } = pageRowBounds(api);
  if (last < first) return;
  rangeAnchor = { rowIndex: first, colId: cols[0].getColId() };
  rangeHead = { rowIndex: last, colId: cols[cols.length - 1].getColId() };
  scheduleRangeRefresh();
}

// Click the row-number gutter → select the whole row (all columns); shift+click
// → extend the row range from the existing anchor row. Expressed as a range
// spanning every column, so copy / keyboard / clearing all work unchanged.
function selectFullRow(rowIndex: number, extend: boolean): void {
  if (!gridApi) return;
  const cols = displayedDataCols(gridApi);
  if (cols.length === 0) return;
  const firstColId = cols[0].getColId();
  const lastColId = cols[cols.length - 1].getColId();
  const anchorRow = extend && rangeAnchor ? rangeAnchor.rowIndex : rowIndex;
  rangeAnchor = { rowIndex: anchorRow, colId: firstColId };
  rangeHead = { rowIndex, colId: lastColId };
  scheduleRangeRefresh();
}

// Click a column header → select the whole column (all page rows); shift+click
// → extend the column range from the existing anchor column. No-op in paint
// mode (cell selection is color-OFF only). Expressed as a range spanning every
// row on the page.
function selectFullColumn(colId: string, extend: boolean): void {
  if (highlightModeEnabled || !gridApi) return;
  const api = gridApi;
  const cols = displayedDataCols(api);
  if (!cols.some((c) => c.getColId() === colId)) return;
  const { first, last } = pageRowBounds(api);
  if (last < first) return;
  const anchorColId = extend && rangeAnchor ? rangeAnchor.colId : colId;
  rangeAnchor = { rowIndex: first, colId: anchorColId };
  rangeHead = { rowIndex: last, colId };
  scheduleRangeRefresh();
}

// Toggle the M5 click-color on a row (paint). Shared by paint-mode left-click,
// Ctrl/Cmd+click (any mode), and right-click — so coloring works regardless of
// the toggle. Targets the currently-mounted statement.
function paintRow(id: number, node: IRowNode | undefined): void {
  if (mountedTabKey === null || mountedStmtIdx === null) return;
  const stmt = tabs.get(mountedTabKey)?.perStatement.get(mountedStmtIdx);
  if (!stmt) return;
  if (pickerColor === null) {
    if (!stmt.clickColors.has(id)) return;
    stmt.clickColors.delete(id);
  } else if (stmt.clickColors.get(id) === pickerColor) {
    stmt.clickColors.delete(id);
  } else {
    stmt.clickColors.set(id, pickerColor);
  }
  if (gridApi && node) gridApi.redrawRows({ rowNodes: [node] });
}

// Resolve a page row index to its stable __rowId + node (for paint-drag, which
// works in row-index space but stores colors keyed by __rowId).
function rowIdAtIndex(index: number): { id: number; node: IRowNode } | null {
  if (!gridApi) return null;
  const node = gridApi.getDisplayedRowAtIndex(index);
  const id = (node?.data as { __rowId?: unknown })?.__rowId;
  if (!node || typeof id !== 'number') return null;
  return { id, node };
}

// Begin a paint drag on the pressed row. Nothing is painted yet — a no-move
// release toggles a single row (paintRow); a move invert-paints the range.
function startPaintDrag(rowIndex: number): void {
  if (mountedTabKey === null || mountedStmtIdx === null) return;
  const stmt = tabs.get(mountedTabKey)?.perStatement.get(mountedStmtIdx);
  if (!stmt) return;
  paintDragActive = true;
  paintAnchorIndex = rowIndex;
  paintDragMoved = false;
  paintSnapshot = new Map(stmt.clickColors);
  paintRangeMin = -1;
  paintRangeMax = -1;
}

// Invert the row range [anchor..head] against the pre-drag snapshot; restore any
// rows that leave the range. Only rows crossing the boundary since the last
// move are touched (O(delta) per move, not O(range)), so even a long drag stays
// cheap. `enter` = invert vs snapshot; `!enter` = restore the snapshot color.
function applyPaintRange(headIndex: number): void {
  if (!paintDragActive || !gridApi || paintSnapshot === null) return;
  if (mountedTabKey === null || mountedStmtIdx === null) return;
  const stmt = tabs.get(mountedTabKey)?.perStatement.get(mountedStmtIdx);
  if (!stmt) return;
  const { first, last } = pageRowBounds(gridApi);
  if (last < first) return;
  const newMin = Math.max(first, Math.min(paintAnchorIndex, headIndex));
  const newMax = Math.min(last, Math.max(paintAnchorIndex, headIndex));
  if (newMin === paintRangeMin && newMax === paintRangeMax) return;

  const changed: IRowNode[] = [];
  const setRow = (i: number, enter: boolean): void => {
    const hit = rowIdAtIndex(i);
    if (!hit) return;
    const orig = paintSnapshot!.get(hit.id); // PaletteColor | undefined
    const target: PaletteColor | undefined = enter
      ? orig !== undefined
        ? undefined
        : pickerColor ?? undefined
      : orig;
    const curr = stmt.clickColors.get(hit.id);
    if (target === curr) return;
    if (target === undefined) stmt.clickColors.delete(hit.id);
    else stmt.clickColors.set(hit.id, target);
    changed.push(hit.node);
  };

  if (paintRangeMin < 0) {
    // First move: the whole new range enters.
    for (let i = newMin; i <= newMax; i++) setRow(i, true);
  } else {
    // The anchor edge is fixed; only the head edge moves. Touch just the rows
    // that entered or left at each boundary.
    if (newMax > paintRangeMax) for (let i = paintRangeMax + 1; i <= newMax; i++) setRow(i, true);
    else if (newMax < paintRangeMax) for (let i = newMax + 1; i <= paintRangeMax; i++) setRow(i, false);
    if (newMin < paintRangeMin) for (let i = newMin; i <= paintRangeMin - 1; i++) setRow(i, true);
    else if (newMin > paintRangeMin) for (let i = paintRangeMin; i <= newMin - 1; i++) setRow(i, false);
  }
  paintRangeMin = newMin;
  paintRangeMax = newMax;
  if (changed.length) gridApi.redrawRows({ rowNodes: changed });
}

// End a paint drag (document mouseup). A press with no drag is a single toggle
// — defer to paintRow so a plain click keeps its recolor-on-different-color
// behavior; a drag has already been applied incrementally.
function endPaintDrag(): void {
  if (!paintDragActive) return;
  if (!paintDragMoved) {
    const hit = rowIdAtIndex(paintAnchorIndex);
    if (hit) paintRow(hit.id, hit.node);
  }
  paintDragActive = false;
  paintAnchorIndex = -1;
  paintDragMoved = false;
  paintSnapshot = null;
  paintRangeMin = -1;
  paintRangeMax = -1;
}

// Restore a per-statement cell selection saved by disposeGrid, so switching
// files and returning shows the selection exactly as left. Called last on mount
// (after column / sort / page / filter restoration and their selection-clearing
// change events have settled). The mounted-identity guard avoids restoring onto
// a different grid if the user re-switched before this frame ran.
function restoreCellSelection(key: string, stmtIdx: number): void {
  if (!gridApi || mountedTabKey !== key || mountedStmtIdx !== stmtIdx) return;
  const saved = tabs.get(key)?.perStatement.get(stmtIdx)?.cellSelection;
  if (!saved) return;
  rangeAnchor = { ...saved.anchor };
  rangeHead = { ...saved.head };
  recomputeRangeDerived();
  gridApi.refreshCells({ force: true });
}

// Tabs/newlines would corrupt the TSV grid; collapse them so the block pastes
// as a clean rectangle. Mirrors the export's documented behaviour: tab → space,
// newline → the literal two characters backslash-n.
function sanitizeTsvCell(s: string): string {
  return s.replace(/\t/g, ' ').replace(/\r\n|\r|\n/g, '\\n');
}

// Serialize the selected rectangle to TSV (WYSIWYG — getCellValue with
// useFormatter:true returns exactly the displayed text) and hand it to the
// host to write to the OS clipboard.
function copyRangeSelection(): void {
  if (!gridApi || !rangeAnchor || !rangeHead) return;
  recomputeRangeDerived();
  if (selRowMin < 0 || selColIds.size === 0) return;
  const api = gridApi;
  const cols = api
    .getAllDisplayedColumns()
    .filter((c) => !isGutterCol(c) && selColIds.has(c.getColId()));
  if (cols.length === 0) return;
  const lines: string[] = [];
  for (let r = selRowMin; r <= selRowMax; r++) {
    const node = api.getDisplayedRowAtIndex(r);
    if (!node) continue;
    const cells = cols.map((c) => {
      const raw = api.getCellValue({
        rowNode: node,
        colKey: c,
        useFormatter: true,
      }) as unknown;
      const text =
        raw == null ? '' : typeof raw === 'string' ? raw : cellValueToText(raw);
      return sanitizeTsvCell(text);
    });
    lines.push(cells.join('\t'));
  }
  if (lines.length === 0) return;
  post({
    type: 'copy-cells',
    text: lines.join('\n'),
    rows: lines.length,
    cols: cols.length,
  });
}

// Cached canvas 2D context for measuring cell text width (the tooltip
// truncation check). The font tracks the grid theme + zoom, recomputed only
// when the zoom changes — measuring per hover is otherwise free.
let measureCtx: CanvasRenderingContext2D | null = null;
let measureCtxZoom = -1;

function ensureMeasureCtx(): CanvasRenderingContext2D | null {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return null;
  if (measureCtxZoom !== panelZoom) {
    const themeEl = (mountedGridHost?.querySelector(
      '.ag-theme-alpine, .ag-theme-alpine-dark',
    ) ??
      mountedGridHost ??
      document.body) as HTMLElement;
    const style = window.getComputedStyle(themeEl);
    measureCtx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    measureCtxZoom = panelZoom;
  }
  return measureCtx;
}

// Hover tooltip for data cells — the way to read a full value once cell
// selection (color toggle OFF) replaces in-cell text selection. Only shown when
// the value is actually clipped: a fully-visible value ("Customer") gets no
// tooltip; a truncated one ("Hecto Morenot de la Sier…") does.
function cellTooltip(p: ITooltipParams): string | null {
  const v = p.value;
  if (v === null || v === undefined) return null;
  const text =
    p.valueFormatted != null && p.valueFormatted !== ''
      ? String(p.valueFormatted)
      : cellValueToText(v);
  if (text === '') return null;
  const ctx = ensureMeasureCtx();
  const column = p.column;
  if (ctx && column && typeof (column as Column).getActualWidth === 'function') {
    // Cell text area = column width minus left+right cell padding
    // (--ag-cell-horizontal-padding = 4px/side, scaled by zoom). +2px tolerance
    // so a value that only just fits doesn't trigger a tooltip.
    const avail = (column as Column).getActualWidth() - 8 * (panelZoom / 100);
    if (ctx.measureText(text).width <= avail + 2) return null;
  }
  // Guard against a pathological multi-KB cell producing a giant tooltip.
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

// Clear any browser-native text selection. Our grid selection is class-based,
// so this never touches it. Used both to defeat Ctrl/Cmd+A's native select-all
// and to drop a stray selection when switching statement views.
function clearNativeSelection(): void {
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
}

// Defeat Ctrl/Cmd+A's native "select all" (which VS Code webviews may still run
// despite preventDefault) so it can't leave status / error / result text
// highlighted. Cleared on both the microtask and the next frame to cover sync
// and deferred timing. The real backstop is clearNativeSelection() on view
// navigation (drillIntoStatement / backToOverview), since the webview's
// select-all can fire as a deferred command after these run.
function defeatNativeSelectAll(): void {
  queueMicrotask(clearNativeSelection);
  requestAnimationFrame(clearNativeSelection);
}

// One-time document listeners: end a drag anywhere the mouse is released, and
// own the grid keyboard model (arrows / shift / ctrl+shift / Ctrl+A / Ctrl+C /
// Esc). Attached once at module load; they read the live module state + gridApi.
function installRangeSelectionHandlers(): void {
  document.addEventListener('mouseup', () => {
    isDraggingRange = false;
    endPaintDrag();
  });
  document.addEventListener('keydown', (e) => {
    if (highlightModeEnabled) return;
    // Never interfere with typing/selection in a text field (filter search,
    // Monaco rule editor, the double-click text overlay) — let the browser
    // handle the key there. (The overlay handles its own Esc.)
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
    const mod = e.ctrlKey || e.metaKey;

    // Ctrl/Cmd+A acts ONLY on the grid. Intercept it always — even with no
    // cell selected — so the browser's native select-all can never highlight
    // status / error / result text elsewhere in the panel (e.g. a previous
    // statement's "N rows affected"). preventDefault isn't reliable here, so
    // also wipe any native selection it creates.
    if (mod && (e.key === 'a' || e.key === 'A')) {
      if (rangeAnchor) selectAllOnPage();
      e.preventDefault();
      defeatNativeSelectAll();
      return;
    }

    // Remaining actions need an active cell selection.
    if (!rangeAnchor) return;
    if (e.key === 'Escape') {
      clearRangeSelection();
      return;
    }
    if (mod && (e.key === 'c' || e.key === 'C')) {
      copyRangeSelection();
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case 'ArrowUp':
        moveActiveCell(e, -1, 0);
        break;
      case 'ArrowDown':
        moveActiveCell(e, 1, 0);
        break;
      case 'ArrowLeft':
        moveActiveCell(e, 0, -1);
        break;
      case 'ArrowRight':
        moveActiveCell(e, 0, 1);
        break;
    }
  });
}
installRangeSelectionHandlers();

function fillColumnsPopoverList(list: HTMLElement): void {
  list.innerHTML = '';
  if (!gridApi) return;
  const cols = (gridApi.getColumns() ?? []).filter((c) => !isGutterCol(c));
  for (const col of cols) {
    const colId = col.getColId();
    const visible = col.isVisible();
    const def = col.getColDef();
    const label = def.headerName || (def.field as string | undefined) || colId;

    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'columns-option';
    if (!visible) item.classList.add('hidden');
    item.dataset.colId = colId;

    const check = document.createElement('span');
    check.className = 'columns-check';
    check.textContent = visible ? '✓' : '';
    item.appendChild(check);

    const labelEl = document.createElement('span');
    labelEl.className = 'columns-label';
    labelEl.textContent = label;
    item.appendChild(labelEl);

    item.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!gridApi) return;
      const newVisible = !col.isVisible();
      gridApi.setColumnsVisible([colId], newVisible);
      // Re-render just this row's state — cheaper than re-rendering the
      // whole list, and keeps scroll position stable.
      check.textContent = newVisible ? '✓' : '';
      item.classList.toggle('hidden', !newVisible);
      updateColumnsIcon();
    });
    list.appendChild(item);
  }
}

function refreshColumnsPopoverRows(pop: HTMLElement): void {
  const list = pop.querySelector<HTMLElement>('.columns-list');
  if (list) fillColumnsPopoverList(list);
}

/**
 * Right-click context menu on a column header. Items, in order:
 *   1. Copy — all values in the column (newline-separated, post filter
 *      + sort) sent through the host clipboard channel.
 *   2. Pin / Unpin — flips colDef.pinned via applyColumnState; AG Grid
 *      handles the region-split + ordering constraint natively.
 *   3. Hide — equivalent to unchecking the column in the owl popover.
 * Rendered as a fixed-position popover at the mouse coordinates.
 */
function openColumnContextMenu(field: string, e: MouseEvent): void {
  if (!gridApi) return;
  closePopover();
  const col = gridApi.getColumn(field);
  if (!col) return;
  const isPinned = col.getPinned() === 'left';

  const menu = document.createElement('div');
  menu.className = 'column-context-menu';
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  // Sort — submenu (Ascending / Descending / Clear sort). Sorting moved here
  // from header click (which now selects the column). applyColumnState with
  // defaultState {sort:null} = single-column sort. Sorting reorders rows, so it
  // drops any current selection.
  const sortWrap = document.createElement('div');
  sortWrap.className = 'column-context-submenu-parent';
  const sortItem = document.createElement('button');
  sortItem.type = 'button';
  sortItem.className = 'column-context-menu-item';
  sortItem.textContent = 'Sort';
  const chevron = document.createElement('span');
  chevron.className = 'column-context-submenu-chevron';
  chevron.textContent = '▸';
  sortItem.appendChild(chevron);
  sortWrap.appendChild(sortItem);
  const submenu = document.createElement('div');
  submenu.className = 'column-context-submenu';
  const mkSort = (label: string, sort: 'asc' | 'desc' | null): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'column-context-menu-item';
    b.textContent = label;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!gridApi) return;
      gridApi.applyColumnState({
        state: [{ colId: field, sort }],
        defaultState: { sort: null },
      });
      clearRangeSelection();
      closePopover();
    });
    return b;
  };
  submenu.appendChild(mkSort('Ascending', 'asc'));
  submenu.appendChild(mkSort('Descending', 'desc'));
  submenu.appendChild(mkSort('Clear sort', null));
  sortWrap.appendChild(submenu);
  menu.appendChild(sortWrap);

  // 1. Copy column values
  const copyItem = document.createElement('button');
  copyItem.type = 'button';
  copyItem.className = 'column-context-menu-item';
  copyItem.textContent = 'Copy';
  copyItem.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!gridApi) return;
    const lines: string[] = [];
    let rowCount = 0;
    gridApi.forEachNodeAfterFilterAndSort((node) => {
      rowCount++;
      const raw = (node.data as Record<string, unknown> | undefined)?.[field];
      lines.push(cellValueToText(raw));
    });
    const text = lines.join('\n');
    const requestId = `copy-col-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingExportRequests.add(requestId);
    post({ type: 'export-clipboard', requestId, text, rowCount });
    closePopover();
  });
  menu.appendChild(copyItem);

  // 2. Pin / Unpin
  const pinItem = document.createElement('button');
  pinItem.type = 'button';
  pinItem.className = 'column-context-menu-item';
  pinItem.textContent = isPinned ? 'Unpin' : 'Pin';
  pinItem.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!gridApi) return;
    gridApi.applyColumnState({
      state: [{ colId: field, pinned: isPinned ? null : 'left' }],
    });
    closePopover();
  });
  menu.appendChild(pinItem);

  // 3. Hide
  const hideItem = document.createElement('button');
  hideItem.type = 'button';
  hideItem.className = 'column-context-menu-item';
  hideItem.textContent = 'Hide';
  hideItem.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!gridApi) return;
    gridApi.setColumnsVisible([field], false);
    closePopover();
  });
  menu.appendChild(hideItem);

  document.body.appendChild(menu);
  popoverRef = menu;

  // Keep the menu inside the viewport: right-clicking near the right/bottom
  // edge would otherwise clip it. Clamp after append so we can measure size.
  const edgePad = 8;
  const menuRect = menu.getBoundingClientRect();
  let menuLeft = e.clientX;
  let menuTop = e.clientY;
  if (menuLeft + menuRect.width > window.innerWidth - edgePad) {
    menuLeft = Math.max(edgePad, window.innerWidth - menuRect.width - edgePad);
  }
  if (menuTop + menuRect.height > window.innerHeight - edgePad) {
    menuTop = Math.max(edgePad, window.innerHeight - menuRect.height - edgePad);
  }
  menu.style.left = `${menuLeft}px`;
  menu.style.top = `${menuTop}px`;

  // Flip the Sort submenu to the left when there isn't room on the right.
  // The submenu is display:none until hover, so force-measure it off-paint.
  submenu.style.visibility = 'hidden';
  submenu.style.display = 'flex';
  const subWidth = submenu.getBoundingClientRect().width;
  submenu.style.display = '';
  submenu.style.visibility = '';
  if (menuLeft + menuRect.width + subWidth > window.innerWidth - edgePad) {
    sortWrap.classList.add('submenu-flip-left');
  }

  popoverDocClickHandler = (ev: MouseEvent) => {
    if (!popoverRef) return;
    const target = ev.target as Node | null;
    if (target && popoverRef.contains(target)) return;
    closePopover();
  };
  document.addEventListener('mousedown', popoverDocClickHandler, true);
  installEscHandler();
}

/**
 * Coerce a parsed cell value to text for clipboard copy. Mirrors
 * `serializeForFlat` but type-driven by runtime shape instead of
 * ColumnType, since the context menu doesn't carry the parsed schema.
 * Temporal columns survive verbatim because the fidelity patch keeps
 * them as strings.
 */
function cellValueToText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function makePagBtn(
  label: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pag-btn';
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

function onPageSizeChange(key: string, stmtIdx: number, next: PageSize): void {
  const state = tabs.get(key);
  if (!state) return;
  const s = state.perStatement.get(stmtIdx);
  if (!s) return;
  s.pageSize = next;
  if (gridApi) {
    gridApi.setGridOption('paginationPageSize', next);
    updatePaginationControls();
    // A page-size change reflows rows across pages — drop the selection (user
    // action, so unlike the mount-time pagination events this should clear).
    clearRangeSelection();
  }
}

function disposeGrid(): void {
  // Snapshot user-resized column widths and scroll position into the
  // per-statement state BEFORE destroying the grid. The next mountGrid
  // for the same (tabKey, stmtIdx) will replay them so tab / statement
  // switches feel stateful (matches the M5 lifecycle promise: drop only
  // on file close or re-run).
  if (gridApi && mountedTabKey !== null && mountedStmtIdx !== null) {
    const stmt = tabs.get(mountedTabKey)?.perStatement.get(mountedStmtIdx);
    if (stmt) {
      // Single getColumnState() captures widths + sort + sortIndex +
      // hide + pinned + column order. Replayed via applyColumnState
      // with applyOrder: true on remount.
      try {
        stmt.columnState = gridApi.getColumnState();
      } catch {
        // getColumnState unavailable on a partially-destroyed grid.
      }
      // Current pagination page (0-based, undefined when pagination is
      // off or the grid has no rows yet).
      try {
        stmt.currentPage = gridApi.paginationGetCurrentPage();
      } catch {
        // Pagination API throws when the grid is shutting down.
      }
      // Vertical scroll: capture the data viewport's scrollTop directly.
      // We can't use gridApi.getFirstDisplayedRow() — for small unvirtualized
      // grids it always returns 0 regardless of CSS overflow position.
      if (mountedGridHost) {
        const vp = mountedGridHost.querySelector<HTMLElement>('.ag-body-viewport');
        if (vp) stmt.scrollTopPx = vp.scrollTop;
      }
      try {
        // Find the leftmost non-pinned column whose right edge is past
        // the current viewport's left edge — that's the column the user
        // is "scrolled to". Pinned columns (row-number gutter) are
        // anchored to the left and not part of the scrollable range.
        const hRange = gridApi.getHorizontalPixelRange();
        const dataCols = (gridApi.getColumns() ?? []).filter(
          (c) => c.getPinned() == null,
        );
        let edge = 0;
        let leftmostId: string | undefined;
        for (const col of dataCols) {
          const w = col.getActualWidth();
          if (edge + w > hRange.left + 1) {
            leftmostId = col.getColId();
            break;
          }
          edge += w;
        }
        stmt.scrollLeftColId = leftmostId;
      } catch {
        // Horizontal range not available pre-first-render.
      }
      // In-progress filter popup: snapshot it if one is currently shown,
      // so the next mount re-opens + restores it. If nothing is open,
      // clear any prior draft so a closed/applied filter doesn't re-open.
      if (activeFilter && activeFilter.isOpen()) {
        stmt.openFilterDraft = {
          field: activeFilter.field,
          draft: activeFilter.capture(),
        };
      } else {
        stmt.openFilterDraft = undefined;
      }
      // Cell range selection — persist so a file switch + return restores it
      // exactly (Ctrl+A, a drag range, or a single active cell). null when
      // nothing is selected.
      stmt.cellSelection =
        rangeAnchor && rangeHead
          ? { anchor: { ...rangeAnchor }, head: { ...rangeHead } }
          : null;
    }
  }
  if (gridApi) {
    gridApi.destroy();
    gridApi = null;
  }
  mountedTabKey = null;
  mountedStmtIdx = null;
  mountedGridHost = null;
  // The comp that activeFilter pointed to is destroyed with the grid above;
  // a fresh afterGuiAttached on the next mount will re-register it.
  activeFilter = null;
}

// Registered by each filter popup's afterGuiAttached (onShown). Tracks the
// currently-shown filter so disposeGrid can snapshot its draft.
function onFilterShown(handle: ActiveFilterHandle): void {
  activeFilter = handle;
}

// Called by a filter popup's afterGuiAttached to fetch+clear any draft the
// host stashed before a tab switch. Keyed off the mounted (tab, stmt) since
// the popup that's opening always belongs to the current grid. One-shot.
function consumePendingFilterDraft(field: string): FilterDraft | null {
  if (mountedTabKey === null || mountedStmtIdx === null) return null;
  const ss = tabs.get(mountedTabKey)?.perStatement.get(mountedStmtIdx);
  if (ss?.openFilterDraft && ss.openFilterDraft.field === field) {
    const draft = ss.openFilterDraft.draft;
    ss.openFilterDraft = undefined;
    return draft;
  }
  return null;
}

/**
 * Derive a sensible default file basename from the per-file URI key. URI
 * strings come in as `file:///c:/.../foo.sql`; we want `foo`. Strip the
 * trailing `.sql` and URL-decode for spaces / unicode.
 */
function basenameFromKey(key: string): string {
  let s = key;
  try {
    s = decodeURIComponent(key);
  } catch {
    // leave undecoded on bad pct sequences
  }
  const lastSlash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const tail = lastSlash >= 0 ? s.slice(lastSlash + 1) : s;
  return tail.replace(/\.sql$/i, '') || 'result';
}

/**
 * Like basenameFromKey but keeps the `.sql` extension — used for the pin
 * button tooltip and the mismatch banner where the user benefits from seeing
 * the full filename (`query.sql`, not `query`).
 */
function basenameWithExt(key: string): string {
  let s = key;
  try {
    s = decodeURIComponent(key);
  } catch {
    // leave undecoded on bad pct sequences
  }
  const lastSlash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const tail = lastSlash >= 0 ? s.slice(lastSlash + 1) : s;
  return tail || key;
}

/**
 * Format a duration in milliseconds per the M11 spec:
 *   < 1 s   → `42 ms`
 *   1–60 s  → `9.3s` (one decimal)
 *   > 60 s  → `2m 15s`
 */
function formatExecutionTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const rounded = Math.round(totalSec);
  const m = Math.floor(rounded / 60);
  const rem = rounded % 60;
  return `${m}m ${rem}s`;
}

/**
 * M11 execution-time indicator glyph. Solid filled disc with a cut-out
 * "i" — reads as a classic info badge. Hands cut out with var(--theme-bg)
 * so the inside negative space matches the panel surface in either theme.
 */
function infoIconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" fill="currentColor"/>
    <circle cx="8" cy="5" r="0.95" fill="var(--theme-bg)"/>
    <rect x="7.15" y="7" width="1.7" height="4.5" rx="0.85" fill="var(--theme-bg)"/>
  </svg>`;
}

/**
 * Build the multi-line tooltip for the execution-time indicator. Total on
 * the first line, then a breakdown line per phase. Native title attributes
 * preserve newlines on every platform we target.
 */
function buildTimingTooltip(timing: { totalMs: number; dryMs: number; realMs: number; parseMs: number }): string {
  const total = formatExecutionTime(timing.totalMs);
  const dry = formatExecutionTime(timing.dryMs);
  const real = formatExecutionTime(timing.realMs);
  const parse = formatExecutionTime(timing.parseMs);
  return `Query completed in ${total}\n  Dry-run:  ${dry}\n  Query:    ${real}\n  Parse:    ${parse}`;
}

/**
 * Decide whether the clock icon should appear for the active tab. Per spec:
 * visible only on a successful result with > 0 rows. Hidden during running,
 * error, cancelled (no timing attached), 0-row, overview, banner-only
 * multi-statement states. Returns the timing payload to render, or null.
 */
function activeExecutionTiming(state: WebviewTabState): { totalMs: number; dryMs: number; realMs: number; parseMs: number } | null {
  const result = state.tab.result;
  if (result.kind === 'ok') {
    if (!result.timing) return null;
    // 0-row results suppress the indicator (AC 16). This branch is reachable
    // when M7 unwraps a single-statement SELECT with empty rows into 'ok'.
    if (result.rows.length === 0) return null;
    return result.timing;
  }
  if (result.kind === 'multi') {
    if (!result.timing) return null;
    // Drilled into a specific statement: show the indicator only when it's a
    // SELECT with > 0 rows (matches the 'ok' path). DDL/DML/banner views hide
    // the footer indicator since the chrome is the banner itself.
    if (state.activeStmtIndex !== null) {
      const stmt = result.statements[state.activeStmtIndex];
      if (!stmt) return null;
      if (stmt.kind !== 'select') return null;
      if (stmt.rows.length === 0) return null;
    }
    // Overview path: the spec says the footer indicator is for the active
    // grid. The overview has no footer (renderOverviewTable doesn't append
    // one), so this branch effectively only fires for drill-in.
    return result.timing;
  }
  return null;
}

function renderExecutionTimeIndicator(timing: { totalMs: number; dryMs: number; realMs: number; parseMs: number }): HTMLElement {
  // Icon-only — full breakdown lives in the native hover tooltip. Wrapper
  // hosts the ::before puddle that gives the icon its depth (no chip).
  const wrap = document.createElement('span');
  wrap.className = 'execution-time';
  wrap.setAttribute('aria-label', 'Query execution time');
  wrap.title = buildTimingTooltip(timing);
  const icon = document.createElement('span');
  icon.className = 'execution-time-icon';
  icon.innerHTML = infoIconSvg();
  wrap.appendChild(icon);
  return wrap;
}

function showExportStatus(text: string, kind: 'ok' | 'warn' | 'err'): void {
  const el = document.querySelector('.export-status') as HTMLSpanElement | null;
  if (!el) return;
  el.textContent = text;
  el.className = `export-status export-status-${kind} visible`;
  // Clear any prior timer by stamping a unique id on the element.
  const id = (Number(el.dataset.tid) || 0) + 1;
  el.dataset.tid = String(id);
  window.setTimeout(() => {
    if (el.dataset.tid !== String(id)) return; // a newer toast superseded
    el.textContent = '';
    el.className = 'export-status';
  }, 2400);
}

/**
 * Build the callback set passed to the M10 export button. The button
 * itself owns the menu UI + row collection + serialization; we just
 * surface the live grid API + statement context + a message pipe to the
 * host. View columns are passed in (not source columns) so explode-mode
 * dotted columns export as the user sees them.
 */
function buildExportCallbacks(
  active: WebviewTabState,
  stmtIdx: number,
  viewColumns: ParsedColumn[],
): ExportButtonCallbacks {
  const isMulti = isMultiResult(active.tab.result);
  // Statement suffix is 1-based (matches BQ console / spec). Single-stmt
  // 'ok' runs pass null so no `-stmtN` lands in the filename.
  const statementIndex = isMulti ? stmtIdx + 1 : null;
  return {
    getGridApi: () => gridApi,
    getColumns: () => viewColumns,
    getFileBasename: () => basenameFromKey(active.tab.key),
    getStatementIndex: () => statementIndex,
    sendSaveRequest: (req) => {
      pendingExportRequests.add(req.requestId);
      post({
        type: 'export-save',
        requestId: req.requestId,
        format: req.format,
        defaultFilename: req.defaultFilename,
        content: req.content,
      });
    },
    sendClipboardRequest: (req) => {
      pendingExportRequests.add(req.requestId);
      post({
        type: 'export-clipboard',
        requestId: req.requestId,
        text: req.text,
        rowCount: req.rowCount,
      });
    },
    showStatus: showExportStatus,
  };
}

function mountGrid(
  host: HTMLDivElement,
  columns: ParsedColumn[],
  rows: ParsedRow[],
  pageSize: PageSize | null,
  key: string,
  stmtIdx: number,
): void {
  disposeGrid();

  const rowData = rows.map((row, idx) => ({ ...row, __rowId: idx }));

  // Rule colors are stored on the per-statement state object so they can be
  // mutated in place when rules change — that lets us call gridApi.redrawRows()
  // instead of a full remount, preserving scroll / sort / filter / page.
  const tabState = tabs.get(key);
  const stmtState = tabState?.perStatement.get(stmtIdx);
  const ruleColors = stmtState?.ruleColors ?? new Map<number, string>();
  if (stmtState) {
    const fresh = computeRuleColors(getRulesFor(key), columns, rows);
    stmtState.ruleColors.clear();
    for (const [k, v] of fresh) stmtState.ruleColors.set(k, v);
  }

  const rowNumWidth = computeRowNumberWidth(host, rows.length);
  // The row-number gutter column. Per spec [[project-formula-language]],
  // when a rule matches a row, the click color paints ONLY the gutter cell
  // here; the data cells get the rule color via getRowClass. When no rule
  // matches, the click color paints the whole row (existing M5 behaviour).
  const rowNumberCol: ColDef = {
    headerName: '',
    valueGetter: (p: ValueGetterParams) =>
      p.node && p.node.rowIndex != null ? p.node.rowIndex + 1 : '',
    pinned: 'left',
    lockPosition: 'left',
    suppressMovable: true,
    suppressMenu: true,
    sortable: false,
    filter: false,
    resizable: false,
    suppressAutoSize: true,
    minWidth: rowNumWidth,
    width: rowNumWidth,
    cellClass: (params: CellClassParams) => {
      const state = tabs.get(key);
      const stmt = state?.perStatement.get(stmtIdx);
      if (!stmt) return undefined;
      const id = (params.data as { __rowId?: unknown })?.__rowId;
      if (typeof id !== 'number') return undefined;
      const ruleColor = ruleColors.get(id);
      const clickColor = stmt.clickColors.get(id);
      // When a rule matches the row, only the gutter shows the click color
      // (the row class won't paint the gutter because the cellClass below
      // overrides the row background for this cell). When no rule matches,
      // the row class already painted the gutter via getRowClass; we don't
      // need an extra cellClass.
      if (ruleColor && clickColor) {
        return `gutter-mark gutter-mark-${clickColor}`;
      }
      return undefined;
    },
  };

  const onColumnFilterChanged = (
    field: string,
    model: SheetsFilterModel | null,
  ): void => {
    const st = tabs.get(key);
    const ss = st?.perStatement.get(stmtIdx);
    if (!ss) return;
    if (model === null) ss.columnFilters.delete(field);
    else ss.columnFilters.set(field, model);
  };

  // M12: Ctrl/Cmd+click column-header highlights. Custom header reads/
  // mutates the per-statement state Set via these closures so each grid
  // mount is bound to the right (tabKey, stmtIdx) slot.
  const headerCallbacks: ColumnHeaderParams = {
    isHighlighted: (field) => {
      const ss = tabs.get(key)?.perStatement.get(stmtIdx);
      return ss?.columnHighlights.has(field) ?? false;
    },
    toggleHighlight: (field) => {
      const ss = tabs.get(key)?.perStatement.get(stmtIdx);
      if (!ss) return;
      if (ss.columnHighlights.has(field)) ss.columnHighlights.delete(field);
      else ss.columnHighlights.add(field);
    },
    openContextMenu: (field, e) => openColumnContextMenu(field, e),
    selectColumn: (colId, e) => selectFullColumn(colId, e.shiftKey),
    isPaintMode: () => highlightModeEnabled,
  };

  const colDefs: ColDef[] = [
    rowNumberCol,
    ...columns.map((c) =>
      buildColDefWithRule(c, ruleColors, onColumnFilterChanged, headerCallbacks, rows),
    ),
  ];

  // Footer row count, filter-aware. Reads the live filter model + displayed
  // count off the module-level `gridApi` (assigned below) and the full total
  // off `rows`. "Filter engaged" mirrors updateClearFiltersButton's test for
  // consistency. The `.row-count` span lives in this grid's footer (sibling
  // of the grid host inside .grid-wrap).
  const refreshRowCount = (): void => {
    if (!gridApi) return;
    const el = host.parentElement?.querySelector<HTMLElement>('.row-count');
    if (!el) return;
    const model = gridApi.getFilterModel();
    const filterActive = !!model && Object.keys(model).length > 0;
    renderRowCount(el, gridApi.getDisplayedRowCount(), rows.length, filterActive);
  };

  const options: GridOptions = {
    columnDefs: colDefs,
    rowData,
    defaultColDef: {
      sortable: true,
      filter: true,
      resizable: true,
      minWidth: 60,
    },
    animateRows: false,
    suppressMenuHide: true,
    // Re-paint the footer columns-icon (eye / mixed-slash / full-slash)
    // whenever a column's visibility flips. Catches both popover toggles
    // and the built-in drag-out-to-hide gesture.
    onColumnVisible: () => updateColumnsIcon(),
    // Fires on every filter change: column-header popover apply/clear,
    // setFilterModel from this file's clear-all button, or any other
    // programmatic mutation. Two responsibilities here:
    //   1. Sync stmtState.columnFilters from the live grid model.
    //      The per-column filter's onApply/onClear callbacks already
    //      do this for popover flows — but setFilterModel(null) bypasses
    //      them, so without this sync the persisted Map keeps stale
    //      entries and the next tab re-mount replays the just-cleared
    //      filter.
    //   2. Toggle the footer clear-all-filters button visibility.
    onFilterChanged: () => {
      const stmtState = tabs.get(key)?.perStatement.get(stmtIdx);
      if (stmtState) {
        const model = (gridApi?.getFilterModel() ?? {}) as Record<string, unknown>;
        stmtState.columnFilters.clear();
        for (const [field, m] of Object.entries(model)) {
          if (m) stmtState.columnFilters.set(field, m as SheetsFilterModel);
        }
      }
      updateClearFiltersButton();
      // Reset to the first row whenever the filter changes (applied OR
      // cleared) — matches the user's mental model that "the data
      // changed, show me the top". Horizontal scroll is intentionally
      // preserved: if the user was looking at a specific column on the
      // right, they probably still want to be there after filtering.
      // Pagination also returns to page 1 so the user doesn't end up on
      // a now-empty page.
      // Skip when the grid hasn't rendered yet — this event also fires
      // during setFilterModel(fm) at mount-time (filter restoration);
      // the host querySelector returns null then, and our scroll-restore
      // rAF in onFirstDataRendered owns post-mount scroll anyway.
      if (gridApi) {
        gridApi.paginationGoToFirstPage();
      }
      const vp = host.querySelector<HTMLElement>('.ag-body-viewport');
      if (vp) vp.scrollTop = 0;
      // Live-update the footer "matched / total" count on every filter change.
      refreshRowCount();
      // Filtering remaps displayed row indices, so any cell-range selection
      // would now point at the wrong rows — drop it. (Mount-time setFilterModel
      // on our custom comp does NOT fire onFilterChanged, so this is only
      // reached on a genuine user filter apply / clear.)
      clearRangeSelection();
    },
    // Render filter popups as direct children of document.body so our
    // modal-style filter (position: fixed backdrop + centered card) is not
    // constrained by the grid container's overflow / stacking context.
    popupParent: document.body,
    pagination: pageSize !== null,
    paginationPageSize: pageSize ?? 100,
    suppressPaginationPanel: true,
    // In-cell text selection is intentionally OFF: in color-OFF mode a drag
    // selects a rectangle of CELLS (onCellMouseDown/Over below), not text;
    // in color-ON mode clicks paint. Either way native text-select is unused.
    enableCellTextSelection: false,
    // Suppress AG Grid's native cell focus + keyboard navigation. Its focus
    // cursor moves independently of our selection (drifting "into the column
    // and row"), which is exactly what we don't want — we own the active cell
    // and all keyboard nav (arrows / shift / ctrl+shift / ctrl+A) ourselves.
    suppressCellFocus: true,
    // Same for headers: keep AG Grid's header keyboard handling from grabbing
    // Ctrl+Shift+Arrow (which moves the column) once a header is clicked — our
    // document keydown owns those keys for extending the column selection.
    // Header mouse actions (select / highlight / filter / menu) don't need it.
    suppressHeaderFocus: true,
    // Hover-to-read full cell values (the read affordance that replaces
    // text-selection). 2s = only on a deliberate dwell, so a casual pass-over
    // doesn't fire it (the standard tooltip threshold; also AG Grid's default).
    tooltipShowDelay: 2000,
    icons: {
      menu: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M1 3l5 6v4l4 1V9l5-6z"/></svg>',
    },
    getRowClass: (params: RowClassParams) => {
      const state = tabs.get(key);
      const stmt = state?.perStatement.get(stmtIdx);
      const id = (params.data as { __rowId?: unknown })?.__rowId;
      if (typeof id !== 'number') return undefined;
      const ruleColor = ruleColors.get(id);
      const clickColor = stmt?.clickColors.get(id);
      // Rule wins on data cells (data cells inherit the row class). The
      // gutter cell overrides via its own cellClass to keep click visible.
      if (ruleColor) return `highlight-${ruleColor}`;
      // No rule for this row: click paints the entire row (M5 behaviour).
      if (clickColor) return `highlight-${clickColor}`;
      return undefined;
    },
    // Sheets-style cell range selection (color toggle OFF). These no-op in
    // color-ON mode, where onCellClicked below owns the click (paint).
    onCellMouseDown: onRangeCellMouseDown,
    onCellMouseOver: onRangeCellMouseOver,
    onCellDoubleClicked: onRangeCellDoubleClicked,
    // The text overlay is position:fixed over a cell; close it when the grid
    // scrolls (it can't track the moving cell).
    onBodyScroll: () => exitTextMode(),
    // Painting (toggle-on click, Ctrl/Cmd+click, and the new drag) is owned by
    // onCellMouseDown → onCellMouseOver → document mouseup (start/apply/end
    // PaintDrag), so there's no onCellClicked paint handler — it would
    // double-toggle the row the mousedown already handled.
    onCellContextMenu: (event: CellContextMenuEvent) => {
      // Right-click on a cell/row has no behavior of its own — coloring is via
      // Ctrl/Cmd+click or a paint-mode left-click. Just suppress the browser
      // context menu so right-click stays inert here.
      (event.event as MouseEvent | undefined)?.preventDefault();
    },
    onFirstDataRendered: () => {
      if (gridApi) {
        const saved = tabs.get(key)?.perStatement.get(stmtIdx);
        // Skip the O(rows × cols) canvas auto-sizer when we already have
        // saved column widths for this exact column set — the widths come
        // back via applyColumnState below, so re-measuring every row just to
        // overwrite the result is wasted work (and the visible stall when
        // switching back to a large result). First mount of a result (or
        // after a render-mode change) has no matching cache, so it measures.
        const colsKey = columns.map((c) => c.field).join('');
        const hasSavedWidths = !!(saved?.columnState && saved.columnState.length > 0);
        const canSkipSizing = hasSavedWidths && saved?.sizedColumnsKey === colsKey;
        if (!canSkipSizing) {
          sizeColumnsForContent(host, gridApi, rows);
          if (saved) saved.sizedColumnsKey = colsKey;
        }
        // Single applyColumnState replays widths, sort + sortIndex, hide
        // (popover + drag-out), pinned, AND column reorder (via applyOrder).
        // Runs AFTER sizeColumnsForContent so any saved width overrides
        // the canvas-derived default; defaultState neutralizes columns
        // not present in the saved state so a fresh grid with no prior
        // state still mounts cleanly.
        if (saved?.columnState && saved.columnState.length > 0) {
          gridApi.applyColumnState({
            state: saved.columnState,
            applyOrder: true,
            defaultState: { sort: null, hide: false, pinned: null },
          });
        }
        // Restore pagination page. Must come after applyColumnState since
        // hide/sort can affect the displayed row count. Defensive bounds
        // check: paginationGoToPage tolerates out-of-range silently in v31,
        // but the explicit guard makes the no-op case clear.
        if (saved?.currentPage && saved.currentPage > 0) {
          const totalPages = gridApi.paginationGetTotalPages();
          if (saved.currentPage < totalPages) {
            gridApi.paginationGoToPage(saved.currentPage);
          }
        }
        // Restore scroll position. Deferred to the next animation frame
        // so the setColumnWidths call above has time to settle into final
        // layout — applying scroll on the same tick as a width change can
        // be silently clamped by AG Grid's internal viewport sync.
        // Vertical: direct DOM scrollTop on `.ag-body-viewport` (the v31
        // index-based ensureIndexVisible misfires for small unvirtualized
        // grids). Horizontal: ensureColumnVisible(colId, 'start') — the
        // supported v31 API, since direct scrollLeft is overridden by the
        // apple-scrollbar overlay sync.
        const savedScroll = saved;
        requestAnimationFrame(() => {
          // Reveal the grid now. Every DOM mutation in this rAF callback
          // (scroll, column-visible scroll, filter popup) is batched into
          // the single paint that follows the callback — so the user sees
          // the fully-restored grid appear at once, never the intermediate
          // jumps. Revealed unconditionally (even if gridApi vanished) so
          // the host can never get stuck hidden.
          host.style.visibility = '';
          // Re-enable transitions only AFTER the restored layout has painted,
          // so none of the width/scroll restoration shows as an animation.
          const reenableTransitions = () =>
            requestAnimationFrame(() => host.classList.remove('grid-initializing'));
          if (!gridApi) {
            reenableTransitions();
            return;
          }
          if (savedScroll?.scrollTopPx && savedScroll.scrollTopPx > 0) {
            const vp = host.querySelector<HTMLElement>('.ag-body-viewport');
            if (vp) vp.scrollTop = savedScroll.scrollTopPx;
          }
          if (
            savedScroll?.scrollLeftColId &&
            gridApi.getColumn(savedScroll.scrollLeftColId)
          ) {
            gridApi.ensureColumnVisible(savedScroll.scrollLeftColId, 'start');
          }
          // Re-open an in-progress filter popup if one was open when the
          // user switched away. showColumnFilter triggers the filter's
          // afterGuiAttached → consumePendingFilterDraft → restoreDraft.
          // Guard on the column existing + visible (a hidden column can't
          // show its filter).
          const pending = savedScroll?.openFilterDraft;
          if (pending) {
            const col = gridApi.getColumn(pending.field);
            if (col && col.isVisible()) {
              gridApi.showColumnFilter(pending.field);
            }
          }
          reenableTransitions();
        });
      }
      updatePaginationControls();
      // Restore the saved cell selection after this frame — guaranteed to run
      // after applyColumnState / page restore above AND the synchronous
      // setFilterModel in mountGrid — then lift the mount-time clear-suppress.
      // A file switch and return thus shows the selection exactly as left.
      requestAnimationFrame(() => {
        // Skip if a newer mount has superseded this one (rapid file switch).
        if (mountedTabKey !== key || mountedStmtIdx !== stmtIdx) return;
        restoreCellSelection(key, stmtIdx);
      });
    },
    onPaginationChanged: () => {
      updatePaginationControls();
      // Selection is intentionally NOT cleared here: page restoration on mount
      // fires this event programmatically and would wipe the restored
      // selection. Genuine user page changes clear via the pagination buttons /
      // page-size handler instead.
    },
    onSortChanged: (event) => {
      // Clear only on a genuine user header sort. Programmatic applyColumnState
      // during mount fires source 'api' and must NOT wipe the restored
      // selection; a user header click fires 'uiColumnSorted'.
      if (event.source === 'uiColumnSorted') clearRangeSelection();
    },
  };

  // Drop any cell-range selection from the previous grid — the module-level
  // selection state outlives a remount, and the new grid's cellClassRule must
  // not light up stale rows/cols on first render.
  resetRangeSelectionState();
  gridApi = createGrid(host, options);
  mountedTabKey = key;
  mountedStmtIdx = stmtIdx;
  mountedGridHost = host;

  // Restore any saved per-column filters. The grid lazily instantiates each
  // column's filter on demand; setFilterModel forces instantiation and
  // pushes the model in. This must run AFTER createGrid so the grid API is
  // ready. setModel on our SheetsFilterComp does NOT fire onFilterChanged,
  // so this won't re-persist the same model.
  if (stmtState && stmtState.columnFilters.size > 0) {
    const fm: Record<string, SheetsFilterModel> = {};
    const colFields = new Set(columns.map((c) => c.field));
    for (const [field, model] of stmtState.columnFilters) {
      if (colFields.has(field)) fm[field] = model;
      else stmtState.columnFilters.delete(field);
    }
    if (Object.keys(fm).length > 0) gridApi.setFilterModel(fm);
  }

  // Reflect the (possibly restored) filter state in the footer count. The
  // mount-time setFilterModel above does NOT fire onFilterChanged for our
  // custom SheetsFilterComp, so the onFilterChanged refresh won't run here;
  // do it explicitly. Deferred a frame so the filtered row model has settled
  // before getDisplayedRowCount() is read. Harmless (idempotent) with no
  // filters — it just re-renders the plain total.
  requestAnimationFrame(refreshRowCount);
  // (Cell-selection restore happens in onFirstDataRendered's frame, which is
  // ordered after all the programmatic state restoration — see there.)
}

// Extends the M6 buildColDef with a rule-aware cellClass on data columns.
// When a rule matches a row, the row class paints the data cells via the
// .highlight-<color> rule defined in styles.css. The gutter override is
// handled separately on the row-number column above.
function buildColDefWithRule(
  col: ParsedColumn,
  _ruleColors: Map<number, string>,
  onColumnFilterChanged: (field: string, model: SheetsFilterModel | null) => void,
  headerCallbacks: ColumnHeaderParams,
  rows: ParsedRow[],
): ColDef {
  return buildColDef(col, onColumnFilterChanged, headerCallbacks, rows);
}

function sizeColumnsForContent(
  host: HTMLDivElement,
  api: GridApi,
  rows: ParsedRow[],
): void {
  const themeEl = (host.querySelector('.ag-theme-alpine, .ag-theme-alpine-dark') ??
    host) as HTMLElement;
  const style = window.getComputedStyle(themeEl);
  const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.font = font;

  // Constants scale with zoom so the floor/ceiling track the font growth.
  // Otherwise: at 200% the cell text doubles in width but the 200px MAX
  // ceiling stays fixed — every column hits it and "doesn't change."
  // Inverse at 50%: a 60px floor keeps columns wider than they need to be.
  // The +icon reservations scale because the filter chevron itself is
  // rendered at the zoomed font-size.
  const factor = panelZoom / 100;
  const FILTER_RESERVE = 22 * factor;
  const SIDE_PADDING = 10 * factor;
  const MIN_WIDTH = 60 * factor;
  const MAX_WIDTH = 200 * factor;

  const widths: { key: string; newWidth: number }[] = [];
  for (const col of api.getColumns() ?? []) {
    const def = col.getColDef();
    const field = def.field;
    if (!field || def.suppressAutoSize) continue;

    const headerName = String(def.headerName ?? field);
    const headerWidth = ctx.measureText(headerName).width;

    let contentWidth = 0;
    for (const row of rows) {
      const v = (row as Record<string, unknown>)[field];
      if (v == null || v === '') continue;
      // Only scalar arrays reach here (ARRAY<STRUCT>/STRUCT set suppressAutoSize);
      // measure their rendered `[a, b, …]` preview, not String()'s comma-join, so
      // the width matches what the cell actually shows.
      const str = Array.isArray(v)
        ? previewArray(v)
        : v instanceof Date
          ? v.toISOString()
          : String(v);
      const w = ctx.measureText(str).width;
      if (w > contentWidth) contentWidth = w;
    }

    const target = Math.ceil(Math.max(headerWidth, contentWidth) + FILTER_RESERVE + SIDE_PADDING);
    const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, target));
    widths.push({ key: col.getColId(), newWidth: clamped });
  }
  if (widths.length > 0) api.setColumnWidths(widths);
}

function computeRowNumberWidth(host: HTMLDivElement, rowCount: number): number {
  const themeEl = (host.querySelector('.ag-theme-alpine, .ag-theme-alpine-dark') ??
    host) as HTMLElement;
  const style = window.getComputedStyle(themeEl);
  const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return 60;
  ctx.font = font;

  const maxNum = String(rowCount || 1);
  const w = ctx.measureText(maxNum).width;
  return Math.max(30, Math.ceil(w + 10));
}

// First non-empty array value for a column across the rows — used to tell a
// scalar array apart from an ARRAY<STRUCT>. The element type decides how the
// cell renders (preview span vs inline table) and how it's sized.
function firstNonEmptyArray(field: string, rows: ParsedRow[]): unknown[] | null {
  for (const row of rows) {
    const v = (row as Record<string, unknown>)[field];
    if (Array.isArray(v) && v.length > 0) return v;
  }
  return null;
}

function buildColDef(
  col: ParsedColumn,
  onColumnFilterChanged: (field: string, model: SheetsFilterModel | null) => void,
  headerCallbacks: ColumnHeaderParams,
  rows: ParsedRow[],
): ColDef {
  const nestedKind = nestedKindFor(col.type);
  const isDotted = col.field.includes('.');
  const dottedValueGetter = isDotted
    ? (p: ValueGetterParams) =>
        (p.data as Record<string, unknown> | undefined)?.[col.field]
    : undefined;

  // M12 custom header — same shape for nested and scalar columns. The
  // header component checks params.enableMenu internally and omits the
  // funnel for nested cols (filter: false below).
  const headerComponentBlock = {
    headerComponent: ColumnHeader,
    headerComponentParams: headerCallbacks,
  };

  if (nestedKind) {
    const isArray = nestedKind === 'array';
    const isStructLike = nestedKind === 'struct' || nestedKind === 'json';
    // Distinguish a scalar array (ARRAY<TIMESTAMP/STRING/…>, rendered as a
    // one-line clipped preview) from an ARRAY<STRUCT> (rendered as an inline
    // mini-table). Only the latter — and STRUCT/JSON — need the extra width and
    // auto-height. A scalar array behaves like any ordinary column: content-sized
    // (capped by sizeColumnsForContent), single-line, clipped with an ellipsis.
    const isStructArray = isArray && isArrayOfPlainObjects(firstNonEmptyArray(col.field, rows));
    const isScalarArray = isArray && !isStructArray;
    const usesInlineTable = isStructArray || isStructLike;
    let width = 220;
    if (isStructArray) width = 480;
    else if (isStructLike) width = 360;
    else if (isScalarArray) width = 200;
    return {
      field: col.field,
      headerName: col.field,
      ...(dottedValueGetter ? { valueGetter: dottedValueGetter } : {}),
      sortable: false,
      filter: false,
      resizable: true,
      // Scalar arrays get content-based sizing (capped at the normal MAX_WIDTH)
      // like every other column; inline-table cells keep their fixed width.
      suppressAutoSize: !isScalarArray,
      width,
      minWidth: 80,
      autoHeight: usesInlineTable,
      cellRenderer: NestedCellRenderer,
      cellRendererParams: {
        nestedKind,
        onOpen: openNestedPopover,
      },
      cellClass: 'nested-cell',
      cellClassRules: {
        'sf-cell-selected': (p) => isCellSelected(p.rowIndex, p.column.getColId()),
        'sf-cell-active': (p) => isActiveCell(p.rowIndex, p.column.getColId()),
      },
      headerClass: 'nested-header',
      ...headerComponentBlock,
    };
  }

  // M9: every non-nested column uses the custom Sheets-style filter (two
  // tabs: Filter by condition / Filter by values). Operator set varies by
  // columnType — passed through filterParams to the component.
  const sheetsFilter = {
    filter: SheetsFilterComp,
    filterParams: {
      columnType: col.type,
      onFilterChanged: onColumnFilterChanged,
      onShown: onFilterShown,
      consumePendingDraft: consumePendingFilterDraft,
    },
  };

  const base: ColDef = {
    field: col.field,
    headerName: col.field,
    ...(dottedValueGetter ? { valueGetter: dottedValueGetter } : {}),
    cellClassRules: {
      'null-cell': (p) => p.value === null || p.value === undefined,
      'sf-cell-selected': (p) => isCellSelected(p.rowIndex, p.column.getColId()),
      'sf-cell-active': (p) => isActiveCell(p.rowIndex, p.column.getColId()),
    },
    tooltipValueGetter: cellTooltip,
    ...headerComponentBlock,
  };
  switch (col.type) {
    case 'number':
      return {
        ...base,
        ...sheetsFilter,
        type: 'numericColumn',
        cellDataType: 'number',
        valueFormatter: (p: ValueFormatterParams) => formatNullable(p.value),
      };
    case 'decimal':
      // NUMERIC / BIGNUMERIC: the exact value is kept as a string (DATA-1/2).
      // Display verbatim and right-align like a number, but sort with an exact
      // decimal comparator rather than AG Grid's double-precision numeric sort.
      // cellDataType 'text' stops AG Grid from coercing the string back to a
      // (lossy) number; the numericColumn type only supplies right-alignment.
      return {
        ...base,
        ...sheetsFilter,
        type: 'numericColumn',
        cellDataType: 'text',
        comparator: compareDecimalStrings,
        valueFormatter: (p: ValueFormatterParams) => formatNullable(p.value),
      };
    case 'boolean':
      // Display as the literal text `true` / `false` / `null` (via
      // formatNullable). cellDataType: 'boolean' would trigger AG Grid's
      // built-in checkbox renderer, which is harder to scan when you're
      // looking at a tabular result — match the BQ console's text shape.
      return {
        ...base,
        ...sheetsFilter,
        cellDataType: 'text',
        valueFormatter: (p: ValueFormatterParams) => formatNullable(p.value),
      };
    case 'date':
    case 'datetime':
    case 'timestamp':
    case 'time':
      // BigQuery returns these as strings already (e.g.
      // '2026-04-15 18:17:12.418000 UTC'). We keep that string in the cell
      // value so the grid shows exactly what the BQ console would. Sort is
      // lexicographic on a fixed-width string format = chronological.
      // Filter / formula evaluator parse on demand.
      return {
        ...base,
        ...sheetsFilter,
        cellDataType: 'text',
        valueFormatter: (p: ValueFormatterParams) => formatDateLike(p.value),
      };
    default:
      return {
        ...base,
        ...sheetsFilter,
        cellDataType: 'text',
        valueFormatter: (p: ValueFormatterParams) => formatNullable(p.value),
      };
  }
}

function hasNestedColumns(columns: ParsedColumn[]): boolean {
  return columns.some(
    (c) => c.type === 'struct' || c.type === 'array' || c.type === 'json',
  );
}

function nestedKindFor(t: ParsedColumn['type']): NestedKind | null {
  if (t === 'struct') return 'struct';
  if (t === 'array') return 'array';
  if (t === 'json') return 'json';
  if (t === 'bytes') return 'bytes';
  return null;
}

function formatNullable(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

// Pass-through formatter for DATE / DATETIME / TIMESTAMP / TIME columns.
// parseJson keeps these as the raw BigQuery string (e.g. '2026-04-15
// 18:17:12.418000 UTC') so display = the string verbatim. Defensive Date
// fallback for any straggler value that didn't come through parseJson.
function formatDateLike(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function formatRowCount(total: number): string {
  if (total === 0) return '0 rows';
  return `${total.toLocaleString()} row${total === 1 ? '' : 's'} total`;
}

// Render the footer row count into `el`. No filter engaged: the plain total
// ("5,108 rows total"). Filter engaged: matched / total ("1,050 / 5,108
// rows") with the matched count emphasized (see .rc-matched in styles.css).
// `filterActive` — not displayed !== total — is the trigger, so the fraction
// shows even when every row still matches (the user knows a filter is on).
function renderRowCount(
  el: HTMLElement,
  displayed: number,
  total: number,
  filterActive: boolean,
): void {
  if (!filterActive) {
    el.textContent = formatRowCount(total);
    return;
  }
  el.textContent = '';
  const matched = document.createElement('span');
  matched.className = 'rc-matched';
  matched.textContent = displayed.toLocaleString();
  const sep = document.createElement('span');
  sep.className = 'rc-sep';
  sep.textContent = '/';
  const tot = document.createElement('span');
  tot.className = 'rc-total';
  tot.textContent = `${total.toLocaleString()} row${total === 1 ? '' : 's'}`;
  el.append(matched, sep, tot);
}

/**
 * Build a fresh WebviewTabState from an incoming tab-update message. Resets
 * per-statement state whenever the result transitions to a final-shape kind
 * (ok / multi / error) — that means re-running the file replaces all
 * highlights / page sizes / per-stmt render-mode overrides, matching the
 * existing M6 "new result wipes state" contract. For intermediate kinds
 * (running) we preserve the prior state so a quick cancel-and-rerun
 * doesn't flash empty.
 */
function buildTabState(
  newTab: TabState,
  prev: WebviewTabState | undefined,
): WebviewTabState {
  const result = newTab.result;
  const isFinal =
    result.kind === 'ok' || result.kind === 'multi' || result.kind === 'error';

  if (!isFinal) {
    // 'running' — keep prior state intact.
    return {
      tab: newTab,
      perStatement: prev?.perStatement ?? new Map(),
      activeStmtIndex: prev?.activeStmtIndex ?? null,
    };
  }

  const perStatement = new Map<number, PerStatementState>();
  let activeStmtIndex: number | null = null;
  if (result.kind === 'ok') {
    perStatement.set(0, {
      pageSize: defaultPageSize(result.rows.length),
      clickColors: new Map<number, PaletteColor>(),
      ruleColors: new Map<number, string>(),
      columnFilters: new Map<string, SheetsFilterModel>(),
      columnHighlights: new Set<string>(),
    });
    activeStmtIndex = 0;
  } else if (result.kind === 'multi') {
    // Don't pre-allocate per-stmt entries here — they get lazily initialized
    // on first drill-in via getOrInitStmtState. activeStmtIndex stays null
    // so the overview table is the first thing the user sees.
    activeStmtIndex = null;
  }

  return { tab: newTab, perStatement, activeStmtIndex };
}

function applyHostMessage(msg: HostToWebviewMessage): void {
  switch (msg.type) {
    case 'tab-update': {
      const prev = tabs.get(msg.tab.key);
      tabs.set(msg.tab.key, buildTabState(msg.tab, prev));
      // Auto-unpin trigger #1: ANY Shift+Enter. runForUri always posts a
      // 'running' tab-update first — regardless of which file it's in or
      // whether the query later succeeds, fails, or is cancelled. That's the
      // "I'm starting fresh" signal, so the pin clears. The running file is
      // necessarily the active editor (the run command reads its selection),
      // so adopt it as the editor-driven key here to avoid a one-frame flash
      // of the empty state before the following set-active arrives.
      if (msg.tab.result.kind === 'running') {
        pinnedUri = null;
        editorTabKey = msg.tab.key;
        activeEditorKey = msg.tab.key;
      }
      recomputeActiveKey();
      render();
      syncRuleModalToActiveKey(buildRulesCallbacks());
      break;
    }
    case 'tab-drop':
      tabs.delete(msg.key);
      // Auto-unpin triggers #2 (pinned file closed) and #3 (renamed →
      // close+reopen drops the slot): if the dropped slot was the pinned
      // one, clear the pin so routing reverts to the active editor.
      if (pinnedUri === msg.key) pinnedUri = null;
      if (editorTabKey === msg.key) editorTabKey = null;
      recomputeActiveKey();
      render();
      // The file's gone — drop any saved modal session for it, then re-sync.
      discardModalSession(msg.key);
      syncRuleModalToActiveKey(buildRulesCallbacks());
      break;
    case 'set-active': {
      const prevActiveKey = activeKey;
      editorTabKey = msg.key && tabs.has(msg.key) ? msg.key : null;
      activeEditorKey = msg.activeEditorKey ?? null;
      recomputeActiveKey();
      // While pinned, an editor-focus change doesn't change which result is
      // shown — only the banner/border/icon. Skip the grid re-mount in that
      // case; full render only when the displayed result actually changes.
      if (activeKey === prevActiveKey) {
        updatePinCues();
      } else {
        render();
      }
      // Hide/restore the CF rule modal to match the now-displayed file.
      syncRuleModalToActiveKey(buildRulesCallbacks());
      break;
    }
    case 'theme-changed':
      themePreference = msg.preference;
      if (themeBtnRef) themeBtnRef.title = themeTooltip();
      applyTheme(msg.resolved);
      if (isRulesModalOpen()) notifyModalThemeChange(msg.resolved);
      break;
    case 'highlight-mode-changed': {
      const next = msg.enabled === true;
      if (next === highlightModeEnabled) return;
      highlightModeEnabled = next;
      if (highlightToggleInputRef) highlightToggleInputRef.checked = next;
      applyHighlightModeAttr();
      clearRangeSelection();
      break;
    }
    case 'clipboard-text': {
      const resolve = pendingPasteRequests.get(msg.requestId);
      if (resolve) {
        pendingPasteRequests.delete(msg.requestId);
        resolve(msg.text);
      }
      break;
    }
    case 'export-complete': {
      if (!pendingExportRequests.has(msg.requestId)) break;
      pendingExportRequests.delete(msg.requestId);
      if (msg.kind === 'cancelled') {
        // User dismissed the save dialog — no toast (mirrors VS Code's own
        // save-dialog behaviour: silent on cancel).
        break;
      }
      if (msg.ok) {
        if (msg.kind === 'clipboard') {
          const n = msg.rowCount ?? 0;
          showExportStatus(`Copied ${n.toLocaleString()} row${n === 1 ? '' : 's'}`, 'ok');
        } else if (msg.filename) {
          showExportStatus(`Saved ${msg.filename}`, 'ok');
        } else {
          showExportStatus('Saved', 'ok');
        }
      } else {
        const errText = msg.error ? `Export failed: ${msg.error}` : 'Export failed';
        showExportStatus(errText, 'err');
      }
      break;
    }
    case 'rules-changed': {
      rulesByUri.set(msg.uri, msg.rules);
      // The rule set for the active file changed — repaint rule colors in
      // place (preserving scroll/sort/filter/page) and refresh the badge.
      // Full re-render is unnecessary here and used to snap the grid back
      // to row 1 every time the user edited a rule.
      if (msg.uri === activeKey) {
        updateRulesInPlace(msg.uri);
      }
      // If a rules popover is open and showing the active file's list, it
      // re-renders. The rulesUi module guards against not-open.
      maybeRefreshRulesPopover(buildRulesCallbacks());
      break;
    }
    case 'panel-zoom-changed': {
      // Host-canonical value. Apply with fromHost=true so we don't echo
      // back (would loop) and skip the local-change short-circuit (we want
      // to converge even if our local value matches but CSS drifted).
      setPanelZoom(msg.zoom, /*fromHost*/ true);
      break;
    }
    case 'render-mode-changed': {
      const next: NestedRenderMode = msg.mode === 'explode' ? 'explode' : 'inline';
      if (next === nestedRenderMode) return;
      // Workspace-wide change came from the host (e.g. user changed setting,
      // or another extension instance updated state). Apply globally;
      // per-stmt overrides take precedence on their own statements.
      nestedRenderMode = next;
      for (const state of tabs.values()) {
        // Only clear highlights for statements that don't have an override —
        // those tracked the global default.
        for (const [idx, stmt] of state.perStatement) {
          if (stmt.renderMode === undefined) {
            stmt.clickColors.clear();
            stmt.columnHighlights.clear();
          }
          void idx;
        }
      }
      render();
      break;
    }
  }
}

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  applyHostMessage(event.data);
});

function post(msg: WebviewToHostMessage): void {
  vscode.postMessage(msg);
}

render();
post({ type: 'ready' });
