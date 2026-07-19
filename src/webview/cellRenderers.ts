import type { ICellRendererComp, ICellRendererParams } from 'ag-grid-community';

export type NestedKind = 'struct' | 'array' | 'json' | 'bytes';

export interface NestedRendererParams extends ICellRendererParams {
  nestedKind: NestedKind;
  onOpen: (value: unknown, kind: NestedKind, anchor: HTMLElement) => void;
}

const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?\d+\.\d+(?:[eE][+-]?\d+)?$/;

// Cap the rendered preview string for scalar arrays. The cell clips by width
// (CSS ellipsis) and the click popover holds the complete value, so this only
// guards the DOM against pathologically large arrays.
const PREVIEW_MAX_CHARS = 4000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date)
  );
}

export function isArrayOfPlainObjects(v: unknown): v is Record<string, unknown>[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  for (const item of v) {
    if (!isPlainObject(item)) return false;
  }
  return true;
}

function shortScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  // Render strings bare — no wrapping quotes. Matches the inline STRUCT/ARRAY
  // table convention (formatTableValue) and BigQuery console; a quoted
  // TIMESTAMP string otherwise reads misleadingly as a plain STRING.
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[…${v.length}]`;
  if (isPlainObject(v)) return '{…}';
  return String(v);
}

function expandedItem(v: unknown): string {
  if (isPlainObject(v)) {
    const entries = Object.entries(v).map(([k, val]) => `${k}: ${shortScalar(val)}`);
    return `{${entries.join(', ')}}`;
  }
  if (Array.isArray(v)) {
    return v.length === 0 ? '[]' : `[…${v.length}]`;
  }
  return shortScalar(v);
}

export function previewStruct(v: unknown): string {
  if (!isPlainObject(v)) {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  const entries = Object.entries(v).map(([k, val]) => `${k}: ${shortScalar(val)}`);
  return `{${entries.join(', ')}}`;
}

export function previewArray(v: unknown): string {
  if (!Array.isArray(v)) {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  if (v.length === 0) return '[]';
  // Render the FULL array; the cell clips by width (CSS text-overflow:ellipsis),
  // so widening the column reveals more elements — no fixed `…+N` truncation.
  // The click popover holds the complete value, so cap the string for safety.
  const inner = v.map(expandedItem).join(', ');
  const capped =
    inner.length > PREVIEW_MAX_CHARS
      ? `${inner.slice(0, PREVIEW_MAX_CHARS)}…`
      : inner;
  return `[${capped}]`;
}

export function previewBytes(v: unknown): string {
  if (typeof v !== 'string') return String(v ?? '');
  if (v.length <= 16) return v;
  return `${v.slice(0, 16)}…`;
}

export function bytesToHex(base64: string, maxBytes = 64): string {
  let bin: string;
  try {
    bin = atob(base64);
  } catch {
    return '(not valid base64)';
  }
  const sliced = bin.slice(0, maxBytes);
  const parts: string[] = [];
  for (let i = 0; i < sliced.length; i++) {
    parts.push(sliced.charCodeAt(i).toString(16).padStart(2, '0'));
  }
  const truncated = bin.length > maxBytes ? ` … (+${bin.length - maxBytes} bytes)` : '';
  return parts.join(' ') + truncated;
}

interface FormattedValue {
  text: string;
  cls: string;
}

// Format an array-table cell value in BQ-console style (unquoted strings,
// numbers right-aligned, null italic muted, deeper nests collapsed).
function formatTableValue(v: unknown): FormattedValue {
  if (v === null || v === undefined) return { text: 'null', cls: 'null-cell' };
  if (typeof v === 'boolean') return { text: String(v), cls: '' };
  if (typeof v === 'number') return { text: String(v), cls: 'numeric' };
  if (typeof v === 'string') {
    // INT64 / FLOAT64 round-trip as strings in bq JSON output — render as
    // numbers (right-aligned, no quotes) when the value is numeric.
    if (INT_RE.test(v) || FLOAT_RE.test(v)) return { text: v, cls: 'numeric' };
    return { text: v, cls: '' };
  }
  if (v instanceof Date) return { text: v.toISOString(), cls: '' };
  if (Array.isArray(v)) {
    return { text: v.length === 0 ? '[]' : `[…${v.length}]`, cls: 'nested-ref' };
  }
  if (isPlainObject(v)) return { text: '{…}', cls: 'nested-ref' };
  return { text: String(v), cls: '' };
}

function collectStructFieldOrder(arr: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const item of arr) {
    for (const k of Object.keys(item)) {
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
  }
  return order;
}

interface FlatEntry {
  key: string;
  value: unknown;
}

// Walk a STRUCT recursively, emitting dot-notation keys at the leaves. Mirrors
// BigQuery console's "expand nested struct into flat columns" behavior — except
// flattened vertically (key on the left, value on the right) so it fits in one
// cell. Arrays inside structs are NOT recursed (shown as `[…N]` reference); the
// user can drill in via a sibling array column.
function flattenStruct(v: Record<string, unknown>, prefix = ''): FlatEntry[] {
  const out: FlatEntry[] = [];
  for (const [k, val] of Object.entries(v)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(val)) {
      out.push(...flattenStruct(val, fullKey));
    } else {
      out.push({ key: fullKey, value: val });
    }
  }
  return out;
}

interface TrackedClick {
  target: HTMLElement;
  handler: (e: MouseEvent) => void;
}

type OpenPopover = (value: unknown, kind: NestedKind, anchor: HTMLElement) => void;

// Inner `[…N]` / `{…}` cells inside inline tables become click-to-popover.
// Same affordance as the top-level Q5 long-array fix — without it the user
// can SEE that there's data nested deeper but can't reach it without changing
// the SQL or switching to explode mode.
function attachInnerRefClick(
  td: HTMLElement,
  value: unknown,
  onOpen: OpenPopover,
  tracked: TrackedClick[],
): void {
  const isNonEmptyArray = Array.isArray(value) && value.length > 0;
  const isNonEmptyObj = isPlainObject(value) && Object.keys(value).length > 0;
  if (!isNonEmptyArray && !isNonEmptyObj) return;

  td.classList.add('clickable-nested-ref');
  const innerKind: NestedKind = Array.isArray(value) ? 'array' : 'struct';
  const handler = (e: MouseEvent) => {
    e.stopPropagation();
    onOpen(value, innerKind, td);
  };
  td.addEventListener('click', handler);
  tracked.push({ target: td, handler });
}

function buildStructTable(
  v: Record<string, unknown>,
  onOpen: OpenPopover,
  tracked: TrackedClick[],
): HTMLElement {
  const entries = flattenStruct(v);

  const wrap = document.createElement('div');
  wrap.className = 'nested-struct-table-wrap';

  const table = document.createElement('table');
  table.className = 'nested-struct-table';

  const tbody = document.createElement('tbody');
  for (const { key, value } of entries) {
    const tr = document.createElement('tr');
    const keyTd = document.createElement('td');
    keyTd.className = 'key';
    keyTd.textContent = key;
    tr.appendChild(keyTd);

    const valTd = document.createElement('td');
    const { text, cls } = formatTableValue(value);
    valTd.className = `value ${cls}`.trim();
    valTd.textContent = text;
    attachInnerRefClick(valTd, value, onOpen, tracked);
    tr.appendChild(valTd);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function buildArrayStructTable(
  arr: Record<string, unknown>[],
  onOpen: OpenPopover,
  tracked: TrackedClick[],
): HTMLElement {
  const fields = collectStructFieldOrder(arr);

  const wrap = document.createElement('div');
  wrap.className = 'nested-array-table-wrap';

  const table = document.createElement('table');
  table.className = 'nested-array-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const f of fields) {
    const th = document.createElement('th');
    th.textContent = f;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of arr) {
    const tr = document.createElement('tr');
    for (const f of fields) {
      const td = document.createElement('td');
      const value = row[f];
      const { text, cls } = formatTableValue(value);
      td.textContent = text;
      if (cls) td.className = cls;
      attachInnerRefClick(td, value, onOpen, tracked);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

export class NestedCellRenderer implements ICellRendererComp {
  private eGui!: HTMLElement;
  // Inline tables can attach many inner click handlers (one per `[…N]` / `{…}`
  // reference cell). Track them all so destroy() can release each listener.
  private tracked: TrackedClick[] = [];
  // The value we rendered from — refresh() keeps our DOM when it's unchanged.
  private value: unknown = undefined;

  init(params: NestedRendererParams): void {
    const v = params.value;
    this.value = v;

    if (v === null || v === undefined) {
      this.eGui = document.createElement('span');
      this.eGui.className = 'null-cell';
      this.eGui.textContent = 'null';
      return;
    }

    const kind = params.nestedKind;

    // ARRAY<STRUCT>: inline mini-table — BQ console style. Inner array / struct
    // refs (`[…N]` / `{…}`) inside the table are clickable for popover.
    if (kind === 'array' && isArrayOfPlainObjects(v)) {
      this.eGui = buildArrayStructTable(v, params.onOpen, this.tracked);
      return;
    }

    // STRUCT / JSON: 2-column key/value table with dot-notation for nested
    // struct keys. Inner refs same as ARRAY<STRUCT>.
    if ((kind === 'struct' || kind === 'json') && isPlainObject(v)) {
      this.eGui = buildStructTable(v, params.onOpen, this.tracked);
      return;
    }

    // All other nested kinds: one-line preview. Single-click just selects the
    // cell (grid range selection); double-click opens the full-value popover —
    // handled at the grid level (onRangeCellDoubleClicked), consistent with how
    // plain cells reveal their full value on double-click. The hover underline
    // (.nested-cell-preview:hover) stays as the "there's more here" hint.
    const span = document.createElement('span');
    let preview: string;
    switch (kind) {
      case 'array':
        preview = previewArray(v);
        break;
      case 'bytes':
        // Render the FULL base64 string; CSS text-overflow:ellipsis truncates
        // based on the cell's current width, so resizing the column reveals
        // more of the value. Popover still shows base64 + hex on click.
        preview = typeof v === 'string' ? v : String(v ?? '');
        break;
      case 'json':
      case 'struct':
      default:
        preview = previewStruct(v);
        break;
    }
    span.className = `nested-cell-preview nested-${kind}`;
    span.textContent = preview;
    span.title = preview;
    this.eGui = span;
  }

  getGui(): HTMLElement {
    return this.eGui;
  }

  refresh(params: NestedRendererParams): boolean {
    // Keep our existing DOM when the value is unchanged. Range-selection repaints
    // call gridApi.refreshCells({ force: true }) on every mousedown; returning
    // false there would destroy + recreate this cell element BETWEEN the two
    // clicks of a double-click, so the browser never pairs them into a `dblclick`
    // (which is what opens the popover). Our content derives purely from the
    // immutable cell value, so we only rebuild when that value actually changes.
    return params.value === this.value;
  }

  destroy(): void {
    for (const { target, handler } of this.tracked) {
      target.removeEventListener('click', handler);
    }
    this.tracked = [];
  }
}
