import type { GridApi } from 'ag-grid-community';
import type { ColumnType } from '../../bq/parseJson';

// ---------------------------------------------------------------------------
// Grid search (Ctrl/Cmd+F) — Sheets/Excel-style find over the WHOLE result,
// not just the current page. Rows live client-side, so the scan walks the
// grid's displayed row model (post filter + sort) and the host flips to
// whichever page holds a match.
//
// Scope comes from the cell selection (host.getScope): a column / row / block
// selection limits the search to it; a single cell or no selection searches
// every visible column. Hidden columns are never searched.
//
// Performance model (1M rows is the ceiling — see runQuery's --max_rows):
//   • Columns whose type can't contain the query are skipped outright
//     (columnCanMatch) — "John" never touches a number / date / bool column.
//   • The scan is time-sliced (~10ms chunks) so typing stays responsive; a
//     newer query cancels an in-flight scan via the generation counter.
//   • Only matched ROWS are stored (row index + running match count), not
//     every matched cell — ≤ 8 bytes per row, so even "every row matches"
//     at 1M rows is a few MB. Per-cell positions inside a row are re-tested
//     on demand (a row has at most a few hundred cells).
//   • Match highlighting is a cellClassRule, so it only ever evaluates the
//     cells AG Grid actually renders (the viewport).
// ---------------------------------------------------------------------------

export interface SearchScope {
  // Inclusive displayed-row bounds (global indices, across all pages).
  rowStart: number;
  rowEnd: number;
  // Searchable column ids, in display order.
  colIds: string[];
  // True when the scope spans every displayed row (a whole-column scope, or
  // the global search) — the host keeps a column selection on the new page.
  allRows: boolean;
  // Chip text for a scoped search ("customer_name", "rows 6–9"); null = global.
  label: string | null;
}

export interface SearchCellRef {
  row: number;
  colId: string;
}

export interface GridSearchHost {
  getApi(): GridApi | null;
  getColumnInfo(colId: string): { field: string; type: ColumnType } | null;
  getScope(): SearchScope | null;
  // The active (anchor) cell of the current selection, if any.
  getActiveCell(): SearchCellRef | null;
  // First displayed row of the current page — the origin when nothing is selected.
  getPageFirstRow(): number;
  navigate(row: number, colId: string, scope: SearchScope): void;
  palette: readonly string[];
  colorRows(rows: ArrayLike<number>, color: string | null): void;
}

interface SearchOptions {
  matchCase: boolean;
  wholeCell: boolean;
  includeNested: boolean;
}

interface ColInfo {
  colId: string;
  field: string;
  searchable: boolean;
}

// Position of a match: displayed row + index into `cols`.
interface Pos {
  row: number;
  col: number;
}

interface Results {
  rows: Int32Array; // matched displayed rows, ascending
  cum: Int32Array; // cum[k] = matches in rows[0..k]
  total: number;
}

const DEBOUNCE_MS = 120;
const CHUNK_MS = 10;

let host: GridSearchHost | null = null;
let opts: SearchOptions = { matchCase: false, wholeCell: false, includeNested: false };
let query = '';
let isOpen = false;

let matcher: RegExp | null = null;
let scope: SearchScope | null = null;
let scopeKey = '';
let cols: ColInfo[] = [];
let colIndexById = new Map<string, number>();
let searchableIdx: number[] = [];

let results: Results | null = null;
let scanning = false;
let foundSoFar = 0;
let current: Pos | null = null;
// Where the last navigation put the active cell. If the user has since moved
// it (clicked elsewhere), the next step starts from their cell instead.
let lastNavigated: SearchCellRef | null = null;
let pendingStep = 0;
let generation = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

let widgetEl: HTMLDivElement | null = null;
let inputEl: HTMLInputElement | null = null;
let scopeEl: HTMLSpanElement | null = null;
let countEl: HTMLSpanElement | null = null;
let prevBtn: HTMLButtonElement | null = null;
let nextBtn: HTMLButtonElement | null = null;
let colorBtn: HTMLButtonElement | null = null;
let colorPopover: HTMLDivElement | null = null;
let colorPopoverCleanup: (() => void) | null = null;

// --- Matching --------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMatcher(q: string, o: SearchOptions): RegExp | null {
  if (q.trim() === '') return null;
  const body = escapeRegExp(q);
  return new RegExp(o.wholeCell ? `^${body}$` : body, o.matchCase ? '' : 'i');
}

// Text a cell is matched against — what the grid displays, minus nulls (the
// grid shows a muted "null", but matching it would light up every empty cell
// for a query like "nu").
function cellText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const NUMERIC_QUERY = /^[\d.eE+-]+$/;
// DATE / DATETIME / TIMESTAMP / TIME render as e.g. "2026-04-15 18:17:12.418000 UTC".
const TEMPORAL_QUERY = /^[\d\s\-:.+TZUC]+$/i;

// Type pruning: can any cell of this column type contain the query? Skipping a
// column here is what keeps "John" from scanning numeric / date / bool data.
function columnCanMatch(type: ColumnType, q: string, re: RegExp, o: SearchOptions): boolean {
  switch (type) {
    case 'null':
      return false;
    case 'number':
    case 'decimal':
      return NUMERIC_QUERY.test(q);
    case 'boolean':
      return re.test('true') || re.test('false');
    case 'date':
    case 'datetime':
    case 'timestamp':
    case 'time':
      return TEMPORAL_QUERY.test(q);
    case 'struct':
    case 'array':
    case 'json':
    case 'bytes':
      return o.includeNested;
    default:
      return true;
  }
}

function cellMatches(data: Record<string, unknown> | undefined, col: ColInfo): boolean {
  if (!data || !matcher) return false;
  const t = cellText(data[col.field]);
  return t !== null && matcher.test(t);
}

function rowDataAt(api: GridApi, row: number): Record<string, unknown> | undefined {
  return api.getDisplayedRowAtIndex(row)?.data as Record<string, unknown> | undefined;
}

// First searchable column index strictly after (dir > 0) / before (dir < 0)
// `from` that matches in `row`, or -1.
function matchInRow(row: number, from: number, dir: 1 | -1): number {
  const api = host?.getApi();
  if (!api) return -1;
  const data = rowDataAt(api, row);
  if (dir > 0) {
    for (const j of searchableIdx) if (j > from && cellMatches(data, cols[j])) return j;
  } else {
    for (let i = searchableIdx.length - 1; i >= 0; i--) {
      const j = searchableIdx[i];
      if (j < from && cellMatches(data, cols[j])) return j;
    }
  }
  return -1;
}

function lowerBound(arr: Int32Array, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// --- Scan --------------------------------------------------------------------

// Yield to the event loop between chunks. MessageChannel avoids setTimeout's
// 4ms nested-timer clamp, which would otherwise add ~40% idle time to a scan.
const yieldChannel = new MessageChannel();
let yieldQueue: (() => void)[] = [];
yieldChannel.port1.onmessage = () => {
  const q = yieldQueue;
  yieldQueue = [];
  for (const f of q) f();
};
function yieldThen(f: () => void): void {
  yieldQueue.push(f);
  yieldChannel.port2.postMessage(0);
}

// Scans [origin.row..rowEnd] then wraps to [rowStart..origin.row-1], so the
// first match at/after the user's position is found — and jumped to — as early
// as possible. Totals (and so the "6/130" ordinal) settle when the scan ends.
function startScan(origin: Pos): void {
  const api = host?.getApi();
  if (!api || !scope || !matcher) return;
  const gen = ++generation;
  const { rowStart, rowEnd } = scope;
  const rowsA: number[] = [];
  const cntA: number[] = [];
  const rowsB: number[] = [];
  const cntB: number[] = [];
  let first: Pos | null = null;
  let phaseA = true;
  let r = origin.row;
  let found = 0;
  scanning = true;
  foundSoFar = 0;

  const finish = (): void => {
    const len = rowsA.length + rowsB.length;
    const rows = new Int32Array(len);
    const cum = new Int32Array(len);
    let acc = 0;
    let k = 0;
    for (let i = 0; i < rowsB.length; i++, k++) {
      rows[k] = rowsB[i];
      acc += cntB[i];
      cum[k] = acc;
    }
    for (let i = 0; i < rowsA.length; i++, k++) {
      rows[k] = rowsA[i];
      acc += cntA[i];
      cum[k] = acc;
    }
    results = { rows, cum, total: acc };
    scanning = false;
    if (!current && first) {
      current = first;
      navigateToCurrent();
    }
    // Nothing at/after the origin: wrap to the first match overall.
    if (!current && acc > 0) {
      const j = matchInRow(rows[0], -1, 1);
      if (j >= 0) {
        current = { row: rows[0], col: j };
        navigateToCurrent();
      }
    }
    const steps = pendingStep;
    pendingStep = 0;
    if (steps !== 0) {
      const dir = steps > 0 ? 1 : -1;
      for (let i = 0; i < Math.abs(steps); i++) step(dir);
    }
    updateUi();
    refreshCells();
  };

  const chunk = (): void => {
    if (gen !== generation) return;
    const deadline = performance.now() + CHUNK_MS;
    let n = 0;
    for (;;) {
      if (phaseA && r > rowEnd) {
        phaseA = false;
        r = rowStart;
      }
      if (!phaseA && r >= origin.row) {
        finish();
        return;
      }
      const data = rowDataAt(api, r);
      if (data) {
        let c = 0;
        for (const j of searchableIdx) {
          if (!cellMatches(data, cols[j])) continue;
          c++;
          if (first === null && phaseA && (r !== origin.row || j >= origin.col)) {
            first = { row: r, col: j };
          }
        }
        if (c > 0) {
          if (phaseA) {
            rowsA.push(r);
            cntA.push(c);
          } else {
            rowsB.push(r);
            cntB.push(c);
          }
          found += c;
        }
      }
      r++;
      if ((++n & 127) === 0 && performance.now() > deadline) break;
    }
    foundSoFar = found;
    if (first && !current) {
      current = first;
      navigateToCurrent();
    }
    updateUi();
    yieldThen(chunk);
  };

  chunk();
}

function cancelScan(): void {
  generation++;
  scanning = false;
}

// --- Run / navigate --------------------------------------------------------

function keyOf(s: SearchScope | null): string {
  return s ? `${s.rowStart}:${s.rowEnd}:${s.colIds.join('\u0000')}` : '';
}

function refreshCells(): void {
  host?.getApi()?.refreshCells({ force: true });
}

function clearDebounce(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function scheduleRun(): void {
  // Stop a stale scan now rather than when the debounce fires, so a long scan
  // never competes with the keystrokes that superseded it.
  cancelScan();
  clearDebounce();
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    run();
  }, DEBOUNCE_MS);
}

function run(): void {
  clearDebounce();
  cancelScan();
  // A scoped search resumes from its current match (typing "Jo" → "Joh"
  // stays put if it still matches); a global one from the active cell,
  // which navigation keeps on the current match anyway.
  const prev: SearchCellRef | null =
    current && cols[current.col] ? { row: current.row, colId: cols[current.col].colId } : null;
  results = null;
  current = null;
  pendingStep = 0;
  foundSoFar = 0;
  matcher = null;
  if (!isOpen || !host || !host.getApi()) {
    updateUi();
    refreshCells();
    return;
  }

  scope = host.getScope();
  scopeKey = keyOf(scope);
  const re = buildMatcher(query, opts);
  cols = [];
  colIndexById = new Map();
  searchableIdx = [];
  if (scope) {
    for (const colId of scope.colIds) {
      const info = host.getColumnInfo(colId);
      if (!info) continue;
      const searchable = !!re && columnCanMatch(info.type, query, re, opts);
      colIndexById.set(colId, cols.length);
      if (searchable) searchableIdx.push(cols.length);
      cols.push({ colId, field: info.field, searchable });
    }
  }
  matcher = re;
  if (!re || !scope || scope.rowEnd < scope.rowStart || searchableIdx.length === 0) {
    if (re) results = { rows: new Int32Array(0), cum: new Int32Array(0), total: 0 };
    updateUi();
    refreshCells();
    return;
  }

  let ref = scope.label !== null && prev ? prev : host.getActiveCell();
  if (!ref) ref = { row: host.getPageFirstRow(), colId: scope.colIds[0] };
  let origin: Pos;
  if (ref.row < scope.rowStart || ref.row > scope.rowEnd) {
    origin = { row: scope.rowStart, col: 0 };
  } else {
    origin = { row: ref.row, col: colIndexById.get(ref.colId) ?? 0 };
  }
  updateUi();
  refreshCells();
  startScan(origin);
}

function navigateToCurrent(): void {
  if (!host || !scope || !current) return;
  const colId = cols[current.col]?.colId;
  if (!colId) return;
  host.navigate(current.row, colId, scope);
  lastNavigated = { row: current.row, colId };
  refreshCells();
}

function findAfter(ref: Pos, res: Results): Pos | null {
  const rows = res.rows;
  let k = lowerBound(rows, ref.row);
  if (k < rows.length && rows[k] === ref.row) {
    const j = matchInRow(ref.row, ref.col, 1);
    if (j >= 0) return { row: ref.row, col: j };
    k++;
  }
  if (k >= rows.length) k = 0;
  const j = matchInRow(rows[k], -1, 1);
  return j >= 0 ? { row: rows[k], col: j } : null;
}

function findBefore(ref: Pos, res: Results): Pos | null {
  const rows = res.rows;
  let k = lowerBound(rows, ref.row);
  if (k < rows.length && rows[k] === ref.row) {
    const j = matchInRow(ref.row, ref.col, -1);
    if (j >= 0) return { row: ref.row, col: j };
  }
  k--;
  if (k < 0) k = rows.length - 1;
  const j = matchInRow(rows[k], cols.length, -1);
  return j >= 0 ? { row: rows[k], col: j } : null;
}

function step(dir: 1 | -1): void {
  if (!host || !matcher) return;
  if (debounceTimer) {
    // Typed but the debounced run hasn't fired: run now — that lands on the
    // first match, which is what this keypress should reach.
    run();
    return;
  }
  if (scanning) {
    pendingStep += dir;
    return;
  }
  if (!results || results.total === 0) return;
  let ref: Pos | null = current;
  if (scope && scope.label === null) {
    // Global search follows the user: if they clicked another cell since the
    // last jump, continue from there.
    const a = host.getActiveCell();
    if (a && (!lastNavigated || a.row !== lastNavigated.row || a.colId !== lastNavigated.colId)) {
      const ci = colIndexById.get(a.colId);
      if (ci !== undefined) ref = { row: a.row, col: ci };
    }
  }
  if (!ref) ref = { row: scope ? scope.rowStart : 0, col: -1 };
  const next = dir > 0 ? findAfter(ref, results) : findBefore(ref, results);
  if (!next) return;
  current = next;
  navigateToCurrent();
  updateUi();
}

function ordinalOf(pos: Pos, res: Results): number {
  const k = lowerBound(res.rows, pos.row);
  const before = k > 0 ? res.cum[k - 1] : 0;
  const api = host?.getApi();
  const data = api ? rowDataAt(api, pos.row) : undefined;
  let inRow = 0;
  for (const j of searchableIdx) {
    if (j >= pos.col) break;
    if (cellMatches(data, cols[j])) inRow++;
  }
  return before + inRow + 1;
}

// --- Cell-class hooks (called per rendered cell) ----------------------------

export function isSearchHit(rowIndex: number | null, colId: string, data: unknown): boolean {
  if (!matcher || !scope || rowIndex === null) return false;
  if (rowIndex < scope.rowStart || rowIndex > scope.rowEnd) return false;
  const ci = colIndexById.get(colId);
  if (ci === undefined || !cols[ci].searchable) return false;
  return cellMatches(data as Record<string, unknown> | undefined, cols[ci]);
}

export function isSearchCurrent(rowIndex: number | null, colId: string): boolean {
  if (!current || !matcher) return false;
  return current.row === rowIndex && cols[current.col]?.colId === colId;
}

// --- Host notifications ----------------------------------------------------

export function attachGridSearch(h: GridSearchHost): void {
  host = h;
}

// Grid torn down (file / statement switch, re-run): stop and close. The query
// and toggles are kept so reopening pre-fills them.
export function detachGridSearch(): void {
  cancelScan();
  clearDebounce();
  closeColorPopover();
  host = null;
  isOpen = false;
  matcher = null;
  scope = null;
  scopeKey = '';
  results = null;
  current = null;
  lastNavigated = null;
  cols = [];
  colIndexById = new Map();
  searchableIdx = [];
  widgetEl?.classList.add('hidden');
}

// Selection changed (click / drag / keyboard). Re-run only if that changed
// the scope — moving the active cell inside a global search doesn't.
// Debounced: a drag changes the scope every frame.
export function notifySearchSelectionChanged(): void {
  if (!isOpen || !host || query.trim() === '') return;
  if (keyOf(host.getScope()) !== scopeKey) scheduleRun();
}

// Filter / sort / column visibility or order changed: row indices and the
// searchable column set may have shifted, so rescan.
export function notifySearchDataChanged(): void {
  if (!isOpen || !host || query.trim() === '') return;
  scheduleRun();
}

// --- Widget ----------------------------------------------------------------

export function isSearchOpen(): boolean {
  return isOpen;
}

export function openSearch(): void {
  if (!host || !widgetEl || !inputEl) return;
  const wasOpen = isOpen;
  isOpen = true;
  widgetEl.classList.remove('hidden');
  inputEl.focus();
  inputEl.select();
  if (!wasOpen) run();
}

export function closeSearch(): void {
  if (!isOpen) return;
  isOpen = false;
  closeColorPopover();
  widgetEl?.classList.add('hidden');
  run(); // clears matcher + highlights
}

export function toggleSearch(): void {
  if (isOpen) closeSearch();
  else openSearch();
}

function makeBtn(className: string, label: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.innerHTML = label;
  b.title = title;
  return b;
}

function makeToggle(
  label: string,
  title: string,
  get: () => boolean,
  set: (v: boolean) => void,
): HTMLButtonElement {
  const b = makeBtn('gs-btn gs-toggle', label, title);
  b.setAttribute('aria-pressed', String(get()));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    set(!get());
    b.setAttribute('aria-pressed', String(get()));
    inputEl?.focus();
    if (isOpen) run();
  });
  return b;
}

const ARROW_UP_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>';
const ARROW_DOWN_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/></svg>';
const CLOSE_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const BUCKET_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5 7 3l5 5-4.5 4.5a1.4 1.4 0 0 1-2 0L2.5 9.5a1.4 1.4 0 0 1 0-2z"/><path d="M2.5 8.5h9.5"/><path d="M13.5 10.5s1 1.3 1 2a1 1 0 0 1-2 0c0-.7 1-2 1-2z" fill="currentColor"/></svg>';

// Floating find bar, anchored top-right over the grid (like VS Code's find
// widget). Created hidden with every grid render; `hasNested` decides whether
// the "include nested columns" toggle is offered at all.
export function renderSearchWidget(hasNested: boolean): HTMLElement {
  closeColorPopover();
  const box = document.createElement('div');
  box.className = isOpen ? 'gs-widget' : 'gs-widget hidden';

  const scopeChip = document.createElement('span');
  scopeChip.className = 'gs-scope hidden';
  box.appendChild(scopeChip);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'gs-input';
  input.placeholder = 'Find';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.value = query;
  input.addEventListener('input', () => {
    query = input.value;
    scheduleRun();
  });
  input.addEventListener('keydown', (e) => {
    // Enter / Shift+Enter step through matches only while typing here.
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSearch();
    }
  });
  box.appendChild(input);

  box.appendChild(
    makeToggle('Aa', 'Match case', () => opts.matchCase, (v) => (opts = { ...opts, matchCase: v })),
  );
  box.appendChild(
    makeToggle(
      '<span class="gs-whole">ab</span>',
      'Match whole cell',
      () => opts.wholeCell,
      (v) => (opts = { ...opts, wholeCell: v }),
    ),
  );
  if (hasNested) {
    box.appendChild(
      makeToggle(
        '{ }',
        'Include nested columns (ARRAY / STRUCT / JSON / BYTES) — slower on large results',
        () => opts.includeNested,
        (v) => (opts = { ...opts, includeNested: v }),
      ),
    );
  }

  const count = document.createElement('span');
  count.className = 'gs-count';
  box.appendChild(count);

  const prev = makeBtn('gs-btn', ARROW_UP_SVG, 'Previous match (Shift+Enter)');
  prev.addEventListener('click', (e) => {
    e.stopPropagation();
    step(-1);
  });
  box.appendChild(prev);

  const next = makeBtn('gs-btn', ARROW_DOWN_SVG, 'Next match (Enter)');
  next.addEventListener('click', (e) => {
    e.stopPropagation();
    step(1);
  });
  box.appendChild(next);

  const sep = document.createElement('span');
  sep.className = 'gs-sep';
  box.appendChild(sep);

  const color = makeBtn('gs-btn', BUCKET_SVG, 'Color rows with matches');
  color.addEventListener('click', (e) => {
    e.stopPropagation();
    if (colorPopover) closeColorPopover();
    else openColorPopover(color);
  });
  box.appendChild(color);

  const close = makeBtn('gs-btn', CLOSE_SVG, 'Close (Escape)');
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    closeSearch();
  });
  box.appendChild(close);

  widgetEl = box;
  inputEl = input;
  scopeEl = scopeChip;
  countEl = count;
  prevBtn = prev;
  nextBtn = next;
  colorBtn = color;
  updateUi();
  return box;
}

function updateUi(): void {
  if (!countEl) return;
  const hasQuery = !!matcher;
  const total = results?.total ?? 0;
  countEl.classList.remove('gs-none');
  if (!hasQuery) {
    countEl.textContent = '';
  } else if (scanning) {
    countEl.textContent = foundSoFar > 0 ? `${foundSoFar.toLocaleString()}+…` : 'Searching…';
  } else if (total === 0) {
    countEl.textContent = 'No results';
    countEl.classList.add('gs-none');
  } else {
    const ord = current && results ? ordinalOf(current, results) : 0;
    countEl.textContent = `${ord ? ord.toLocaleString() : '?'}/${total.toLocaleString()}`;
  }
  const navigable = hasQuery && (scanning || total > 0);
  if (prevBtn) prevBtn.disabled = !navigable;
  if (nextBtn) nextBtn.disabled = !navigable;
  if (colorBtn) {
    const rowsMatched = results?.rows.length ?? 0;
    colorBtn.disabled = !hasQuery || scanning || rowsMatched === 0;
    colorBtn.title =
      rowsMatched > 0
        ? `Color the ${rowsMatched.toLocaleString()} row${rowsMatched === 1 ? '' : 's'} with matches`
        : 'Color rows with matches';
  }
  if (scopeEl && inputEl) {
    const label = isOpen ? (scope?.label ?? null) : null;
    scopeEl.classList.toggle('hidden', label === null);
    scopeEl.textContent = label ?? '';
    scopeEl.title = label ? `Searching only in: ${label}` : '';
    inputEl.placeholder = label ? 'Find in selection' : 'Find';
  }
}

function closeColorPopover(): void {
  colorPopoverCleanup?.();
  colorPopoverCleanup = null;
  colorPopover?.remove();
  colorPopover = null;
}

function openColorPopover(anchor: HTMLElement): void {
  closeColorPopover();
  if (!host || !results || results.rows.length === 0) return;
  const pop = document.createElement('div');
  pop.className = 'gs-color-popover';
  pop.addEventListener('mousedown', (e) => e.stopPropagation());

  const title = document.createElement('div');
  title.className = 'gs-color-title';
  const n = results.rows.length;
  title.textContent = `Color ${n.toLocaleString()} matching row${n === 1 ? '' : 's'}`;
  pop.appendChild(title);

  const apply = (c: string | null): void => {
    if (host && results) host.colorRows(results.rows, c);
    closeColorPopover();
    inputEl?.focus();
  };
  for (const c of [...host.palette, null]) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = `color-swatch ${c ? `swatch-${c}` : 'swatch-none'}`;
    sw.title = c ?? 'Remove color from matching rows';
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      apply(c);
    });
    pop.appendChild(sw);
  }

  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  const w = pop.getBoundingClientRect().width;
  pop.style.top = `${rect.bottom + 4}px`;
  pop.style.left = `${Math.max(8, Math.min(rect.right - w, window.innerWidth - w - 8))}px`;
  colorPopover = pop;

  // The anchor button toggles the popover itself — ignore its own mousedown.
  const onDocDown = (e: MouseEvent): void => {
    if (!anchor.contains(e.target as Node | null)) closeColorPopover();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeColorPopover();
    }
  };
  document.addEventListener('mousedown', onDocDown);
  document.addEventListener('keydown', onKey, true);
  colorPopoverCleanup = () => {
    document.removeEventListener('mousedown', onDocDown);
    document.removeEventListener('keydown', onKey, true);
  };
}
