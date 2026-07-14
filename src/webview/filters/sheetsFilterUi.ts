import type { ParsedColumn } from '../../bq/parseJson';
import { compareDec, isDecimalString } from '../decimal';
import {
  BLANK_SENTINEL,
  computeDistinctValues,
  formatDistinctValue,
  isBlank,
  valueKey,
  type DistinctValue,
} from './distinctValues';

// Filter model — JSON-serializable so AG Grid can round-trip it via
// getModel() / setModel(). Conditions store raw string inputs; the predicate
// parses them per-type at evaluation time (numbers / dates).
export type Combinator = 'AND' | 'OR';

// Operator catalogue — keys are stable across types so the model survives
// edits and round-trips. UI labels are looked up per-type below.
export type StringOp =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'blank'
  | 'notBlank';
export type NumDateOp =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'between'
  | 'blank'
  | 'notBlank';
export type BooleanOp = 'eq' | 'neq' | 'blank' | 'notBlank';
export type AnyOp = StringOp | NumDateOp | BooleanOp;

export interface ConditionTerm {
  op: AnyOp;
  val?: string;
  valB?: string;
}

export interface SheetsFilterCondition {
  term1: ConditionTerm;
  combinator?: Combinator;
  term2?: ConditionTerm;
}

export interface SheetsFilterModel {
  filterType: 'sheets';
  condition?: SheetsFilterCondition;
  // Stored as the stable key strings from valueKey() — independent of value
  // identity so a re-rendered grid (different Date instances etc.) still
  // matches the excluded set correctly.
  exclusionKeys?: string[];
}

export interface SheetsFilterUiOpts {
  field: string;
  columnType: ParsedColumn['type'];
  onApply: (model: SheetsFilterModel | null) => void;
  onClear: () => void;
  onCancel: () => void;
}

// In-progress (uncommitted) popup state. Snapshotted before a tab-switch
// tears the grid down, replayed when the popup is re-opened on return —
// so "open a filter, peek at another tab, come back" preserves exactly
// what the user was doing. Distinct from SheetsFilterModel, which is the
// COMMITTED filter (already persisted independently).
export interface FilterDraft {
  activeTab: 'cond' | 'values';
  search: string;
  scrollTop: number;
  renderedCount: number;
  // Currently-checked value keys (in-progress, may differ from the
  // committed model's selection).
  checkedKeys: string[];
  // Raw condition inputs — captured verbatim even when incomplete /
  // invalid, because a draft is allowed to be mid-edit.
  row1: { op: string; val: string; valB: string } | null;
  row2: { op: string; val: string; valB: string } | null;
  combinator: Combinator;
}

export interface SheetsFilterUiHandle {
  rootEl: HTMLDivElement;
  // Called from afterGuiAttached so the popup state is fresh each open.
  // When `draft` is supplied, the committed model is applied first (to
  // establish value order) then the draft overlays the in-progress edits.
  refresh: (opts: {
    model: SheetsFilterModel | null;
    allRows: ReadonlyArray<Record<string, unknown>>;
    draft?: FilterDraft | null;
  }) => void;
  // Snapshot the current in-progress UI state.
  captureDraft: () => FilterDraft;
  // True while the popup is actually shown (rootEl attached to the DOM).
  // Used to decide whether a draft is worth capturing on teardown.
  isOpen: () => boolean;
  destroy: () => void;
}

const PAGE_STEP = 200;

interface OpOption {
  key: AnyOp;
  label: string;
  inputs: 0 | 1 | 2;
}

function opsForType(type: ParsedColumn['type']): OpOption[] {
  if (type === 'number' || type === 'decimal') {
    return [
      { key: 'eq', label: '=', inputs: 1 },
      { key: 'neq', label: '≠', inputs: 1 },
      { key: 'lt', label: '<', inputs: 1 },
      { key: 'lte', label: '≤', inputs: 1 },
      { key: 'gt', label: '>', inputs: 1 },
      { key: 'gte', label: '≥', inputs: 1 },
      { key: 'between', label: 'between', inputs: 2 },
      { key: 'blank', label: 'is blank', inputs: 0 },
      { key: 'notBlank', label: 'is not blank', inputs: 0 },
    ];
  }
  if (type === 'date' || type === 'datetime' || type === 'timestamp') {
    return [
      { key: 'eq', label: '=', inputs: 1 },
      { key: 'neq', label: '≠', inputs: 1 },
      { key: 'lt', label: 'before', inputs: 1 },
      { key: 'lte', label: 'on or before', inputs: 1 },
      { key: 'gt', label: 'after', inputs: 1 },
      { key: 'gte', label: 'on or after', inputs: 1 },
      { key: 'between', label: 'between', inputs: 2 },
      { key: 'blank', label: 'is blank', inputs: 0 },
      { key: 'notBlank', label: 'is not blank', inputs: 0 },
    ];
  }
  if (type === 'boolean') {
    return [
      { key: 'eq', label: 'equals', inputs: 1 },
      { key: 'neq', label: 'not equals', inputs: 1 },
      { key: 'blank', label: 'is blank', inputs: 0 },
      { key: 'notBlank', label: 'is not blank', inputs: 0 },
    ];
  }
  // string / timestamp / time / fallback — text-shaped
  return [
    { key: 'equals', label: 'equals', inputs: 1 },
    { key: 'notEquals', label: 'not equals', inputs: 1 },
    { key: 'contains', label: 'contains', inputs: 1 },
    { key: 'notContains', label: 'not contains', inputs: 1 },
    { key: 'startsWith', label: 'starts with', inputs: 1 },
    { key: 'endsWith', label: 'ends with', inputs: 1 },
    { key: 'blank', label: 'is blank', inputs: 0 },
    { key: 'notBlank', label: 'is not blank', inputs: 0 },
  ];
}

function inputTypeFor(type: ParsedColumn['type']): 'text' | 'number' | 'date' {
  if (type === 'number') return 'number';
  // NUMERIC / BIGNUMERIC: free-text input so a high-precision threshold is
  // preserved exactly (an <input type=number> would round on the way in).
  if (type === 'decimal') return 'text';
  if (type === 'date' || type === 'datetime' || type === 'timestamp') return 'date';
  return 'text';
}

interface ConditionRowRefs {
  container: HTMLDivElement;
  opSelect: HTMLSelectElement;
  input1: HTMLInputElement;
  input2: HTMLInputElement;
  betweenSep: HTMLSpanElement;
}

function buildConditionRow(
  type: ParsedColumn['type'],
  initial: ConditionTerm | undefined,
): ConditionRowRefs {
  const ops = opsForType(type);
  const container = document.createElement('div');
  container.className = 'sf-cond-row';

  const opSelect = document.createElement('select');
  opSelect.className = 'sf-cond-op';
  for (const o of ops) {
    const opt = document.createElement('option');
    opt.value = o.key;
    opt.textContent = o.label;
    opSelect.appendChild(opt);
  }
  if (initial) opSelect.value = initial.op;

  const inputType = inputTypeFor(type);
  const input1 = document.createElement('input');
  input1.type = inputType;
  input1.className = 'sf-cond-val';
  if (initial?.val !== undefined) input1.value = initial.val;

  const betweenSep = document.createElement('span');
  betweenSep.className = 'sf-cond-and';
  betweenSep.textContent = 'and';

  const input2 = document.createElement('input');
  input2.type = inputType;
  input2.className = 'sf-cond-val';
  if (initial?.valB !== undefined) input2.value = initial.valB;

  container.appendChild(opSelect);
  container.appendChild(input1);
  container.appendChild(betweenSep);
  container.appendChild(input2);

  const syncInputVisibility = () => {
    const meta = ops.find((o) => o.key === opSelect.value);
    const n = meta?.inputs ?? 1;
    input1.style.display = n >= 1 ? '' : 'none';
    betweenSep.style.display = n === 2 ? '' : 'none';
    input2.style.display = n === 2 ? '' : 'none';
  };
  syncInputVisibility();
  opSelect.addEventListener('change', syncInputVisibility);

  return { container, opSelect, input1, input2, betweenSep };
}

function readConditionRow(refs: ConditionRowRefs): ConditionTerm | null {
  const op = refs.opSelect.value as AnyOp;
  const meta = opsForType('string').find((o) => o.key === op) ?? null;
  // ^ op metadata is type-agnostic at this layer; we use the input count from
  //   the actual select via the visible input fields instead.
  void meta;
  const v1 = refs.input1.value.trim();
  const v2 = refs.input2.value.trim();
  if (op === 'blank' || op === 'notBlank') return { op };
  // Inputs required for the rest. Empty val on a "between" 2nd input is
  // treated as "no condition" — drop the term.
  if (refs.input2.style.display !== 'none') {
    if (!v1 || !v2) return null;
    return { op, val: v1, valB: v2 };
  }
  if (!v1) return null;
  return { op, val: v1 };
}

// ===== Public builder =====

export function buildSheetsFilterUi(
  opts: SheetsFilterUiOpts,
): SheetsFilterUiHandle {
  // Two-layer DOM: rootEl is the full-viewport backdrop; cardEl is the
  // actual modal card. AG Grid hosts rootEl inside its popup wrapper, but
  // our `position: fixed` styling escapes that wrapper to fill the entire
  // webview. This way the filter card always has usable height regardless
  // of where in the panel the column header sits. Click on backdrop =
  // cancel; click on card body bubbles into our handlers as normal.
  const rootEl = document.createElement('div');
  rootEl.className = 'sheets-filter';

  const cardEl = document.createElement('div');
  cardEl.className = 'sf-card';
  rootEl.appendChild(cardEl);

  // Stop card clicks from bubbling to the backdrop (which cancels).
  cardEl.addEventListener('mousedown', (e) => e.stopPropagation());

  // Header strip — column-name title above the tabs.
  const titleEl = document.createElement('div');
  titleEl.className = 'sf-title';
  titleEl.textContent = `Filter — ${opts.field || 'column'}`;
  cardEl.appendChild(titleEl);

  // Tab bar — "Filter by values" is the default (Sheets parity, and the
  // tab users reach for most often). Tabs are placed values-first so the
  // default landing matches the visible left tab.
  const tabBar = document.createElement('div');
  tabBar.className = 'sf-tabs';
  const tabValuesBtn = document.createElement('button');
  tabValuesBtn.type = 'button';
  tabValuesBtn.className = 'sf-tab sf-tab-values active';
  tabValuesBtn.textContent = 'Filter by values';
  const tabCondBtn = document.createElement('button');
  tabCondBtn.type = 'button';
  tabCondBtn.className = 'sf-tab sf-tab-cond';
  tabCondBtn.textContent = 'Filter by condition';
  tabBar.appendChild(tabValuesBtn);
  tabBar.appendChild(tabCondBtn);
  cardEl.appendChild(tabBar);

  // Tab content host
  const tabBody = document.createElement('div');
  tabBody.className = 'sf-tab-body';
  cardEl.appendChild(tabBody);

  // Condition tab content
  const condPane = document.createElement('div');
  condPane.className = 'sf-pane sf-pane-cond';

  let row1: ConditionRowRefs | null = null;
  let row2: ConditionRowRefs | null = null;
  let combinator: Combinator = 'AND';

  const combinatorRow = document.createElement('div');
  combinatorRow.className = 'sf-combinator-row';
  const combLabel = document.createElement('span');
  combLabel.className = 'sf-combinator-label';
  combLabel.textContent = 'Combine with:';
  const combAndBtn = document.createElement('button');
  combAndBtn.type = 'button';
  combAndBtn.className = 'sf-combinator-btn active';
  combAndBtn.textContent = 'AND';
  const combOrBtn = document.createElement('button');
  combOrBtn.type = 'button';
  combOrBtn.className = 'sf-combinator-btn';
  combOrBtn.textContent = 'OR';
  const addSecondBtn = document.createElement('button');
  addSecondBtn.type = 'button';
  addSecondBtn.className = 'sf-add-second';
  addSecondBtn.textContent = '+ Add condition';
  const removeSecondBtn = document.createElement('button');
  removeSecondBtn.type = 'button';
  removeSecondBtn.className = 'sf-remove-second';
  removeSecondBtn.textContent = '× Remove';
  combinatorRow.appendChild(combLabel);
  combinatorRow.appendChild(combAndBtn);
  combinatorRow.appendChild(combOrBtn);
  combinatorRow.appendChild(addSecondBtn);
  combinatorRow.appendChild(removeSecondBtn);

  const setCombinator = (next: Combinator) => {
    combinator = next;
    combAndBtn.classList.toggle('active', next === 'AND');
    combOrBtn.classList.toggle('active', next === 'OR');
  };
  combAndBtn.addEventListener('click', () => setCombinator('AND'));
  combOrBtn.addEventListener('click', () => setCombinator('OR'));

  // Order matters: combinatorRow is the LAST child of condPane. row1 always
  // sits before it; row2 (when present) sits between row1 and combinatorRow.
  // ensureRow1 / showSecondRow use insertBefore against combinatorRow as the
  // anchor, so combinatorRow must be appended first.
  condPane.appendChild(combinatorRow);

  const ensureRow1 = () => {
    if (!row1) {
      row1 = buildConditionRow(opts.columnType, undefined);
      condPane.insertBefore(row1.container, combinatorRow);
    }
  };
  const showSecondRow = (initial?: ConditionTerm) => {
    if (!row2) {
      row2 = buildConditionRow(opts.columnType, initial);
      condPane.insertBefore(row2.container, combinatorRow);
    }
    addSecondBtn.style.display = 'none';
    removeSecondBtn.style.display = '';
    combLabel.style.display = '';
    combAndBtn.style.display = '';
    combOrBtn.style.display = '';
  };
  const hideSecondRow = () => {
    if (row2) {
      row2.container.remove();
      row2 = null;
    }
    addSecondBtn.style.display = '';
    removeSecondBtn.style.display = 'none';
    combLabel.style.display = 'none';
    combAndBtn.style.display = 'none';
    combOrBtn.style.display = 'none';
  };

  addSecondBtn.addEventListener('click', () => showSecondRow());
  removeSecondBtn.addEventListener('click', () => hideSecondRow());

  ensureRow1();
  hideSecondRow();

  tabBody.appendChild(condPane);

  // Values tab content
  const valuesPane = document.createElement('div');
  valuesPane.className = 'sf-pane sf-pane-values active';

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'sf-values-search';
  searchInput.placeholder = 'Search values';

  const bulkRow = document.createElement('div');
  bulkRow.className = 'sf-values-bulk';
  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.className = 'sf-bulk-link';
  selectAllBtn.textContent = 'Select all';
  const deselectAllBtn = document.createElement('button');
  deselectAllBtn.type = 'button';
  deselectAllBtn.className = 'sf-bulk-link';
  deselectAllBtn.textContent = 'Deselect all';
  bulkRow.appendChild(selectAllBtn);
  bulkRow.appendChild(document.createTextNode(' · '));
  bulkRow.appendChild(deselectAllBtn);

  const valuesListWrap = document.createElement('div');
  valuesListWrap.className = 'sf-values-list-wrap';
  const valuesList = document.createElement('div');
  valuesList.className = 'sf-values-list';
  valuesListWrap.appendChild(valuesList);

  const loadMoreBtn = document.createElement('button');
  loadMoreBtn.type = 'button';
  loadMoreBtn.className = 'sf-load-more';
  loadMoreBtn.textContent = 'Load more';
  loadMoreBtn.style.display = 'none';

  const valuesEmpty = document.createElement('div');
  valuesEmpty.className = 'sf-values-empty';
  valuesEmpty.textContent = 'No matching values';
  valuesEmpty.style.display = 'none';

  valuesPane.appendChild(searchInput);
  valuesPane.appendChild(bulkRow);
  valuesPane.appendChild(valuesListWrap);
  valuesPane.appendChild(loadMoreBtn);
  valuesPane.appendChild(valuesEmpty);

  tabBody.appendChild(valuesPane);

  // Footer buttons
  const footer = document.createElement('div');
  footer.className = 'sf-footer';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'sf-clear';
  clearBtn.textContent = 'Clear';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'sf-cancel';
  cancelBtn.textContent = 'Cancel';
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'sf-apply';
  applyBtn.textContent = 'Apply';
  footer.appendChild(clearBtn);
  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  footer.appendChild(spacer);
  footer.appendChild(cancelBtn);
  footer.appendChild(applyBtn);
  cardEl.appendChild(footer);

  // Click on backdrop (outside the card) = cancel. Mousedown captures
  // before any inner element gets focus, so it's a cleaner trigger than
  // click. The cardEl swallows its own mousedowns above.
  rootEl.addEventListener('mousedown', (e) => {
    if (e.target === rootEl) {
      uninstallEsc();
      opts.onCancel();
    }
  });

  // Esc handler is attached on refresh() (when the popup is shown) and
  // removed on the next refresh() / destroy(). We bind it to document so
  // it works even if focus is inside the card's inputs.
  let escHandler: ((e: KeyboardEvent) => void) | null = null;
  const installEsc = () => {
    if (escHandler) document.removeEventListener('keydown', escHandler, true);
    escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        opts.onCancel();
      }
    };
    document.addEventListener('keydown', escHandler, true);
  };
  const uninstallEsc = () => {
    if (escHandler) {
      document.removeEventListener('keydown', escHandler, true);
      escHandler = null;
    }
  };

  // ===== Values tab state =====
  // All distinct values for the current row set. Recomputed on refresh().
  let allValues: DistinctValue[] = [];
  // Checked set keyed by valueKey(); presence = checked. We track the
  // checked set (not the excluded set) for snappy "Select all" semantics.
  // The model's exclusionKeys is the complement of checkedKeys ∩ allValueKeys.
  const checkedKeys = new Set<string | symbol>();
  // How many filtered-search-matched values are currently rendered. Grows
  // by PAGE_STEP each "Load more". Reset on search input.
  let renderedCount = 0;
  let currentSearch = '';

  function refreshValuesPane(): void {
    valuesList.innerHTML = '';
    const q = currentSearch.trim().toLowerCase();
    const filtered = q
      ? allValues.filter((v) => {
          if (v === BLANK_SENTINEL) return '(blanks)'.includes(q);
          return formatDistinctValue(v).toLowerCase().includes(q);
        })
      : allValues;

    if (filtered.length === 0) {
      valuesEmpty.style.display = '';
      loadMoreBtn.style.display = 'none';
      return;
    }
    valuesEmpty.style.display = 'none';

    if (renderedCount === 0) {
      renderedCount = Math.min(PAGE_STEP, filtered.length);
    }

    const showCount = Math.min(renderedCount, filtered.length);
    for (let i = 0; i < showCount; i++) {
      valuesList.appendChild(buildValueRow(filtered[i]));
    }

    if (filtered.length > showCount) {
      loadMoreBtn.style.display = '';
      const remaining = filtered.length - showCount;
      loadMoreBtn.textContent = `Load more (${remaining} remaining)`;
    } else {
      loadMoreBtn.style.display = 'none';
    }
  }

  function buildValueRow(value: DistinctValue): HTMLLabelElement {
    const row = document.createElement('label');
    row.className = 'sf-value-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'sf-value-checkbox';
    const k = value === BLANK_SENTINEL ? '__blank__' : valueKey(value);
    cb.checked = checkedKeys.has(k);
    cb.addEventListener('change', () => {
      if (cb.checked) checkedKeys.add(k);
      else checkedKeys.delete(k);
    });
    const text = document.createElement('span');
    text.className = 'sf-value-text';
    if (value === BLANK_SENTINEL) {
      text.textContent = '(Blanks)';
      text.classList.add('sf-value-blanks');
    } else {
      text.textContent = formatDistinctValue(value);
    }
    row.appendChild(cb);
    row.appendChild(text);
    return row;
  }

  searchInput.addEventListener('input', () => {
    currentSearch = searchInput.value;
    renderedCount = 0;
    refreshValuesPane();
  });

  loadMoreBtn.addEventListener('click', () => {
    renderedCount += PAGE_STEP;
    refreshValuesPane();
  });

  selectAllBtn.addEventListener('click', () => {
    const q = currentSearch.trim().toLowerCase();
    const targets = q
      ? allValues.filter((v) => {
          if (v === BLANK_SENTINEL) return '(blanks)'.includes(q);
          return formatDistinctValue(v).toLowerCase().includes(q);
        })
      : allValues;
    for (const v of targets) {
      const k = v === BLANK_SENTINEL ? '__blank__' : valueKey(v);
      checkedKeys.add(k);
    }
    refreshValuesPane();
  });

  deselectAllBtn.addEventListener('click', () => {
    const q = currentSearch.trim().toLowerCase();
    const targets = q
      ? allValues.filter((v) => {
          if (v === BLANK_SENTINEL) return '(blanks)'.includes(q);
          return formatDistinctValue(v).toLowerCase().includes(q);
        })
      : allValues;
    for (const v of targets) {
      const k = v === BLANK_SENTINEL ? '__blank__' : valueKey(v);
      checkedKeys.delete(k);
    }
    refreshValuesPane();
  });

  // ===== Tabs =====
  const setActiveTab = (which: 'cond' | 'values') => {
    tabCondBtn.classList.toggle('active', which === 'cond');
    tabValuesBtn.classList.toggle('active', which === 'values');
    condPane.classList.toggle('active', which === 'cond');
    valuesPane.classList.toggle('active', which === 'values');
  };
  tabCondBtn.addEventListener('click', () => setActiveTab('cond'));
  tabValuesBtn.addEventListener('click', () => setActiveTab('values'));

  // ===== Buttons =====
  applyBtn.addEventListener('click', () => {
    uninstallEsc();
    opts.onApply(buildModel());
  });
  cancelBtn.addEventListener('click', () => {
    uninstallEsc();
    opts.onCancel();
  });
  clearBtn.addEventListener('click', () => {
    // Reset UI and emit a null model.
    uninstallEsc();
    resetUiToBlank();
    opts.onClear();
  });

  function buildModel(): SheetsFilterModel | null {
    const condTerm1 = row1 ? readConditionRow(row1) : null;
    const condTerm2 = row2 ? readConditionRow(row2) : null;

    let condition: SheetsFilterCondition | undefined;
    if (condTerm1) {
      condition = { term1: condTerm1 };
      if (condTerm2) {
        condition.combinator = combinator;
        condition.term2 = condTerm2;
      }
    }

    // Values: build excluded set as the complement of checkedKeys within
    // allValues. If everything is checked, no values are excluded.
    const exclusionKeys: string[] = [];
    for (const v of allValues) {
      const k = v === BLANK_SENTINEL ? '__blank__' : valueKey(v);
      if (!checkedKeys.has(k)) {
        // valueKey returns a string for non-blank values; '__blank__' is the
        // string we use for the blank sentinel.
        exclusionKeys.push(typeof k === 'string' ? k : '__blank__');
      }
    }

    const model: SheetsFilterModel = { filterType: 'sheets' };
    if (condition) model.condition = condition;
    if (exclusionKeys.length > 0) model.exclusionKeys = exclusionKeys;
    if (!condition && exclusionKeys.length === 0) return null;
    return model;
  }

  function resetUiToBlank(): void {
    if (row1) {
      row1.container.remove();
      row1 = null;
    }
    if (row2) {
      row2.container.remove();
      row2 = null;
    }
    ensureRow1();
    hideSecondRow();
    setCombinator('AND');
    searchInput.value = '';
    currentSearch = '';
    renderedCount = 0;
    checkedKeys.clear();
    for (const v of allValues) {
      const k = v === BLANK_SENTINEL ? '__blank__' : valueKey(v);
      checkedKeys.add(k);
    }
    refreshValuesPane();
  }

  function applyModelToUi(model: SheetsFilterModel | null): void {
    // Always rebuild row1 from scratch so input visibility re-syncs.
    if (row1) {
      row1.container.remove();
      row1 = null;
    }
    if (row2) {
      row2.container.remove();
      row2 = null;
    }
    if (model?.condition) {
      row1 = buildConditionRow(opts.columnType, model.condition.term1);
      condPane.insertBefore(row1.container, combinatorRow);
      if (model.condition.term2) {
        setCombinator(model.condition.combinator ?? 'AND');
        showSecondRow(model.condition.term2);
      } else {
        hideSecondRow();
      }
    } else {
      ensureRow1();
      hideSecondRow();
      setCombinator('AND');
    }

    // Apply values: start with everything checked, then remove exclusions.
    checkedKeys.clear();
    for (const v of allValues) {
      const k = v === BLANK_SENTINEL ? '__blank__' : valueKey(v);
      checkedKeys.add(k);
    }
    if (model?.exclusionKeys) {
      for (const k of model.exclusionKeys) checkedKeys.delete(k);
    }

    // Excel / Sheets behaviour: when reopening a filter that has a partial
    // selection, float the currently-checked values to the top (each
    // group keeps its natural order). Only on open — refreshValuesPane()
    // renders from this order, and we deliberately do NOT re-sort on every
    // checkbox toggle (that would make rows jump under the cursor). On a
    // fresh open (no exclusions = everything checked) the natural order is
    // preserved. Condition-only models have no exclusionKeys and are
    // likewise left untouched.
    if (model?.exclusionKeys && model.exclusionKeys.length > 0) {
      const checked: DistinctValue[] = [];
      const unchecked: DistinctValue[] = [];
      for (const v of allValues) {
        const k = v === BLANK_SENTINEL ? '__blank__' : valueKey(v);
        (checkedKeys.has(k) ? checked : unchecked).push(v);
      }
      allValues = [...checked, ...unchecked];
    }

    searchInput.value = '';
    currentSearch = '';
    renderedCount = 0;
    refreshValuesPane();
  }

  function captureDraft(): FilterDraft {
    return {
      activeTab: condPane.classList.contains('active') ? 'cond' : 'values',
      search: currentSearch,
      scrollTop: valuesListWrap.scrollTop,
      renderedCount,
      checkedKeys: [...checkedKeys].filter(
        (k): k is string => typeof k === 'string',
      ),
      row1: row1
        ? { op: row1.opSelect.value, val: row1.input1.value, valB: row1.input2.value }
        : null,
      row2: row2
        ? { op: row2.opSelect.value, val: row2.input1.value, valB: row2.input2.value }
        : null,
      combinator,
    };
  }

  function restoreDraft(draft: FilterDraft): void {
    // Rebuild condition rows from the raw draft (incomplete inputs allowed).
    if (row1) {
      row1.container.remove();
      row1 = null;
    }
    if (row2) {
      row2.container.remove();
      row2 = null;
    }
    if (draft.row1) {
      row1 = buildConditionRow(opts.columnType, {
        op: draft.row1.op as AnyOp,
        val: draft.row1.val,
        valB: draft.row1.valB,
      });
      condPane.insertBefore(row1.container, combinatorRow);
    } else {
      ensureRow1();
    }
    if (draft.row2) {
      row2 = buildConditionRow(opts.columnType, {
        op: draft.row2.op as AnyOp,
        val: draft.row2.val,
        valB: draft.row2.valB,
      });
      condPane.insertBefore(row2.container, combinatorRow);
      setCombinator(draft.combinator);
      addSecondBtn.style.display = 'none';
      removeSecondBtn.style.display = '';
      combLabel.style.display = '';
      combAndBtn.style.display = '';
      combOrBtn.style.display = '';
    } else {
      hideSecondRow();
      setCombinator(draft.combinator);
    }
    // Values: replace checked set + search + rendered count, then re-render.
    // Note: value ORDER is already correct — applyModelToUi (run just before
    // restoreDraft in refresh) reproduced the selected-first ordering from
    // the committed model, which is the same order that was on screen when
    // the popup was open (toggling checkboxes never re-sorts).
    checkedKeys.clear();
    for (const k of draft.checkedKeys) checkedKeys.add(k);
    searchInput.value = draft.search;
    currentSearch = draft.search;
    renderedCount = draft.renderedCount;
    refreshValuesPane();
    setActiveTab(draft.activeTab);
    // Scroll restore after the list is rendered (synchronous append above).
    valuesListWrap.scrollTop = draft.scrollTop;
  }

  return {
    rootEl,
    refresh({ model, allRows, draft }) {
      // Recompute distinct values for the current row set, then re-bind UI
      // to the supplied model (or all-checked if no model). refresh() is
      // called by afterGuiAttached each time AG Grid shows the popup — so
      // this is also where we (re)install the Esc handler. When a draft is
      // supplied, overlay the in-progress edits on top of the committed
      // model's value order.
      allValues = computeDistinctValues(allRows, opts.field, opts.columnType);
      applyModelToUi(model);
      if (draft) restoreDraft(draft);
      installEsc();
    },
    captureDraft,
    isOpen: () => rootEl.isConnected,
    destroy() {
      uninstallEsc();
      rootEl.remove();
    },
  };
}

// ===== Predicate =====

/**
 * Compile a filter model into a per-row predicate, building the exclusion
 * lookup ONCE up front. Callers that test many rows (the grid filter pass
 * and the cascading-distinct collection) must use this rather than calling
 * `modelMatchesRow` per row: a "filter by values" selection stores the
 * complement as `exclusionKeys` (potentially every distinct value minus the
 * ones kept), and `Array.includes` per row makes the pass O(rows × values)
 * — tens of billions of ops on a 166K-row result, which hangs the webview.
 * A `Set` turns the per-row check into O(1).
 */
export function compileSheetsMatcher(
  model: SheetsFilterModel,
  columnType: ParsedColumn['type'],
): (rawValue: unknown) => boolean {
  const condition = model.condition;
  const exclusionSet =
    model.exclusionKeys && model.exclusionKeys.length > 0
      ? new Set<string>(model.exclusionKeys)
      : null;
  return (rawValue: unknown): boolean => {
    if (condition) {
      if (!conditionMatches(condition, rawValue, columnType)) return false;
    }
    if (exclusionSet) {
      const k = isBlank(rawValue) ? '__blank__' : valueKey(rawValue);
      const ks = typeof k === 'string' ? k : '__blank__';
      if (exclusionSet.has(ks)) return false;
    }
    return true;
  };
}

// Single-shot convenience wrapper. Fine for one-off checks; for per-row
// loops over a large row set, build a matcher once via compileSheetsMatcher
// instead (see the doc comment above).
export function modelMatchesRow(
  model: SheetsFilterModel,
  rawValue: unknown,
  columnType: ParsedColumn['type'],
): boolean {
  return compileSheetsMatcher(model, columnType)(rawValue);
}

function conditionMatches(
  cond: SheetsFilterCondition,
  rawValue: unknown,
  type: ParsedColumn['type'],
): boolean {
  const t1 = termMatches(cond.term1, rawValue, type);
  if (!cond.term2) return t1;
  const t2 = termMatches(cond.term2, rawValue, type);
  return cond.combinator === 'OR' ? t1 || t2 : t1 && t2;
}

function termMatches(
  term: ConditionTerm,
  rawValue: unknown,
  type: ParsedColumn['type'],
): boolean {
  if (term.op === 'blank') return isBlank(rawValue);
  if (term.op === 'notBlank') return !isBlank(rawValue);

  if (isBlank(rawValue)) return false;

  if (type === 'decimal') {
    // NUMERIC / BIGNUMERIC cells are exact strings; compare digit-by-digit so
    // a high-precision threshold filters precisely (no Number() rounding).
    const cell = typeof rawValue === 'string' ? rawValue : String(rawValue);
    const a = (term.val ?? '').trim();
    if (!isDecimalString(cell) || !isDecimalString(a)) return false;
    switch (term.op) {
      case 'eq': return compareDec(cell, a) === 0;
      case 'neq': return compareDec(cell, a) !== 0;
      case 'lt': return compareDec(cell, a) < 0;
      case 'lte': return compareDec(cell, a) <= 0;
      case 'gt': return compareDec(cell, a) > 0;
      case 'gte': return compareDec(cell, a) >= 0;
      case 'between': {
        const b = (term.valB ?? '').trim();
        if (!isDecimalString(b)) return false;
        const lo = compareDec(a, b) <= 0 ? a : b;
        const hi = compareDec(a, b) <= 0 ? b : a;
        return compareDec(cell, lo) >= 0 && compareDec(cell, hi) <= 0;
      }
    }
    return false;
  }

  if (type === 'number') {
    const num = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (Number.isNaN(num)) return false;
    const a = parseFloat(term.val ?? '');
    if (Number.isNaN(a)) return false;
    switch (term.op) {
      case 'eq': return num === a;
      case 'neq': return num !== a;
      case 'lt': return num < a;
      case 'lte': return num <= a;
      case 'gt': return num > a;
      case 'gte': return num >= a;
      case 'between': {
        const b = parseFloat(term.valB ?? '');
        if (Number.isNaN(b)) return false;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        return num >= lo && num <= hi;
      }
    }
    return false;
  }

  if (type === 'date' || type === 'datetime' || type === 'timestamp') {
    // Cell values for DATE / DATETIME / TIMESTAMP are now raw BQ strings
    // (e.g. '2026-04-15', '2026-04-15T18:17:12.418000',
    // '2026-04-15 18:17:12.418000 UTC'). Compare by the leading YYYY-MM-DD
    // portion so the date-picker's YYYY-MM-DD input lines up directly with
    // a single calendar day regardless of microseconds / TZ suffix.
    const cellDate = extractDatePrefix(rawValue);
    if (!cellDate) return false;
    const a = (term.val ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a)) return false;
    switch (term.op) {
      case 'eq': return cellDate === a;
      case 'neq': return cellDate !== a;
      case 'lt': return cellDate < a;
      case 'lte': return cellDate <= a;
      case 'gt': return cellDate > a;
      case 'gte': return cellDate >= a;
      case 'between': {
        const b = (term.valB ?? '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b)) return false;
        const lo = a <= b ? a : b;
        const hi = a <= b ? b : a;
        return cellDate >= lo && cellDate <= hi;
      }
    }
    return false;
  }

  if (type === 'boolean') {
    const bv = typeof rawValue === 'boolean'
      ? rawValue
      : String(rawValue).toLowerCase() === 'true';
    const expected = String(term.val ?? '').toLowerCase() === 'true';
    switch (term.op) {
      case 'eq': return bv === expected;
      case 'neq': return bv !== expected;
    }
    return false;
  }

  // String / timestamp / time / fallback
  const s = formatDistinctValue(rawValue);
  const needle = term.val ?? '';
  const sl = s.toLowerCase();
  const nl = needle.toLowerCase();
  switch (term.op) {
    case 'equals': return sl === nl;
    case 'notEquals': return sl !== nl;
    case 'contains': return sl.includes(nl);
    case 'notContains': return !sl.includes(nl);
    case 'startsWith': return sl.startsWith(nl);
    case 'endsWith': return sl.endsWith(nl);
  }
  return false;
}

// Pull the leading YYYY-MM-DD from a BigQuery DATE / DATETIME / TIMESTAMP
// cell value. Returns null if the value doesn't look temporal. Accepts the
// raw string format BQ returns (the renderer keeps that string verbatim);
// also accepts a Date fallback for defensive callers.
function extractDatePrefix(v: unknown): string | null {
  if (typeof v === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
    return m ? m[1] : null;
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const yyyy = v.getUTCFullYear().toString().padStart(4, '0');
    const mm = (v.getUTCMonth() + 1).toString().padStart(2, '0');
    const dd = v.getUTCDate().toString().padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}
