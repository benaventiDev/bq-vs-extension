// Conditional-formatting rules UI: footer button, rules-list popup, and
// add/edit modal with the Monaco-powered formula editor. Lives entirely in
// the webview; the host is just a persistence + lifecycle echo.
//
// The popup is anchored under the footer button (same pattern as the color
// picker / theme popovers). The modal is centred and modal-style (covers
// the whole webview with a backdrop) since the formula editor needs space.

import type { Rule, RuleColor } from '../../panel/rules/rulesStore';
import { FUNCTIONS, OPERATORS, SYNTAX_NOTES } from '../../formula/docs';
import { parse, type Expr } from '../../formula/parser';
import { buildContext, matches } from '../../formula/evaluator';
import type { ParsedColumn, ParsedRow } from '../../bq/parseJson';
import {
  createFormulaEditor,
  setMonacoTheme,
  type FormulaEditorHandle,
} from './monacoBootstrap';

const RULE_COLORS_ORDER: RuleColor[] = [
  'yellow', 'orange', 'red', 'pink', 'purple', 'blue', 'cyan', 'green', 'brown',
];

export interface RulesUiCallbacks {
  // Identity for the active file URI key. Required so saves echo back with
  // the right routing key.
  getActiveUri: () => string | null;
  // Returns the current rules list for the active URI (from webview state).
  getRules: () => Rule[];
  // Returns the current statement's column list — drives autocomplete and
  // live "matches N of M rows" preview in the modal. Empty array if no
  // statement is active.
  getColumns: () => ParsedColumn[];
  // Returns the current statement's rows — drives the live match preview.
  getRows: () => ParsedRow[];
  // Persist a new rules array (host writes to workspaceState + echoes back).
  saveRules: (rules: Rule[]) => void;
  // Current resolved theme — passed to Monaco editor on create + on theme
  // change while modal is open.
  getResolvedTheme: () => 'light' | 'dark';
  // Reads the OS clipboard via the extension host (webviews block
  // navigator.clipboard.readText() directly). Used by the editor to
  // service Ctrl+V / right-click paste.
  requestClipboardText: () => Promise<string>;
}

let rulesPopoverRef: HTMLDivElement | null = null;
let rulesDocClickHandler: ((e: MouseEvent) => void) | null = null;
let rulesEscHandler: ((e: KeyboardEvent) => void) | null = null;
let modalRef: HTMLDivElement | null = null;
let modalEditor: FormulaEditorHandle | null = null;
let modalEscHandler: ((e: KeyboardEvent) => void) | null = null;
let helpPanelRef: HTMLDivElement | null = null;

// Per-file modal memory. The modal belongs to exactly one file (URI key):
// switching to another file hides it (state preserved) and returning re-shows
// it exactly as left. `modalOwnerKey` is the file the mounted modal belongs to;
// `modalSessions` holds each file's in-progress state so it survives hide/show.
interface ModalSession {
  existing: Rule | null; // the rule being edited (null = adding a new rule)
  formula: string; // in-progress formula text
  color: RuleColor; // selected color
}
let modalOwnerKey: string | null = null;
const modalSessions = new Map<string, ModalSession>();

export function isRulesModalOpen(): boolean {
  return modalRef !== null;
}

export function notifyModalThemeChange(theme: 'light' | 'dark'): void {
  if (modalRef) setMonacoTheme(theme);
}

export function renderConditionalFormattingButton(
  callbacks: RulesUiCallbacks,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'cond-fmt';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cond-fmt-btn';
  btn.innerHTML = formattingIconSvg();
  const count = callbacks.getRules().length;
  if (count > 0) {
    const badge = document.createElement('span');
    badge.className = 'cond-fmt-badge';
    badge.textContent = String(count);
    btn.appendChild(badge);
    btn.title = `Conditional formatting (${count} rule${count === 1 ? '' : 's'})`;
  } else {
    btn.title = 'Conditional formatting';
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (rulesPopoverRef) {
      closeRulesPopover();
    } else {
      openRulesPopover(btn, callbacks);
    }
  });
  wrap.appendChild(btn);
  return wrap;
}

function formattingIconSvg(): string {
  // Three stacked bars, each filled with a different muted accent color —
  // amber / blue / green — to read as "rows colored by rule" at a glance.
  // Distinct from the inline-mode icon (three outline-only bars) while
  // staying within a minimal palette. Colors are hard-coded RGB (not theme
  // variables) so the icon keeps its semantics on both light and dark.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <rect x="2" y="2.6" width="12" height="3" rx="0.7" fill="#e8a64e"/>
    <rect x="2" y="6.5" width="12" height="3" rx="0.7" fill="#64a0f0"/>
    <rect x="2" y="10.4" width="12" height="3" rx="0.7" fill="#7dc685"/>
  </svg>`;
}

function closeRulesPopover(): void {
  if (rulesPopoverRef && rulesPopoverRef.parentElement) {
    rulesPopoverRef.parentElement.removeChild(rulesPopoverRef);
  }
  rulesPopoverRef = null;
  if (rulesDocClickHandler) {
    document.removeEventListener('mousedown', rulesDocClickHandler, true);
    rulesDocClickHandler = null;
  }
  if (rulesEscHandler) {
    document.removeEventListener('keydown', rulesEscHandler, true);
    rulesEscHandler = null;
  }
}

function openRulesPopover(anchor: HTMLElement, callbacks: RulesUiCallbacks): void {
  closeRulesPopover();
  if (!callbacks.getActiveUri()) {
    // No file active — show a transient hint inline rather than a popover.
    return;
  }
  const pop = document.createElement('div');
  pop.className = 'cond-fmt-popover';

  renderRulesList(pop, callbacks);

  anchor.parentElement?.appendChild(pop);
  rulesPopoverRef = pop;

  rulesDocClickHandler = (e: MouseEvent) => {
    if (!rulesPopoverRef) return;
    const target = e.target as Node | null;
    if (target && (rulesPopoverRef.contains(target) || anchor.contains(target))) return;
    closeRulesPopover();
  };
  document.addEventListener('mousedown', rulesDocClickHandler, true);

  rulesEscHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeRulesPopover();
    }
  };
  document.addEventListener('keydown', rulesEscHandler, true);
}

function renderRulesList(container: HTMLElement, callbacks: RulesUiCallbacks): void {
  container.innerHTML = '';
  const rules = callbacks.getRules();
  const cols = callbacks.getColumns();
  const colNames = new Set(cols.map((c) => c.field.toLowerCase()));

  const header = document.createElement('div');
  header.className = 'cond-fmt-header';
  header.textContent = rules.length === 0
    ? 'Conditional formatting'
    : `Conditional formatting (${rules.length})`;
  container.appendChild(header);

  if (rules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cond-fmt-empty';
    empty.textContent = 'No rules yet. Add one to color rows by formula.';
    container.appendChild(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'cond-fmt-list';
    rules.forEach((rule, idx) => {
      const row = document.createElement('div');
      row.className = 'cond-fmt-row';

      // Double-click anywhere on the rule (except its buttons) opens the edit
      // modal — same action as the ✎ button.
      row.addEventListener('dblclick', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        e.preventDefault();
        closeRulesPopover();
        openRuleModal(callbacks, rule);
      });

      const swatch = document.createElement('span');
      swatch.className = `cond-fmt-swatch swatch-${rule.color}`;
      row.appendChild(swatch);

      const formula = document.createElement('span');
      formula.className = 'cond-fmt-formula';
      formula.textContent = rule.formula;
      formula.title = rule.formula;
      row.appendChild(formula);

      // parse() can throw (e.g. RangeError on a too-deeply-nested formula);
      // without this guard the whole rules list would fail to render (FORM-2).
      let ruleAst: Expr | null = null;
      let parseThrew = false;
      try {
        ruleAst = parse(rule.formula).ast;
      } catch {
        parseThrew = true;
      }
      if (parseThrew || !ruleAst) {
        // Threw (e.g. too deeply nested) OR didn't parse to an AST. Saved rules
        // are save-gated to parse cleanly, so this is only reachable for a
        // corrupt/edited rule — show the same indicator rather than guessing
        // columns from a regex over an unparseable string (FORM-9).
        appendRuleWarning(
          row,
          'Rule could not be evaluated (invalid or too complex) — not applied this run.',
        );
      } else {
        const missing = columnsFromAst(ruleAst).find((c) => !colNames.has(c.toLowerCase()));
        if (missing) {
          appendRuleWarning(
            row,
            `Column "${missing}" not in current result — rule not applied this run.`,
          );
        }
      }

      const upBtn = makeRowBtn('▲', 'Move up', () => {
        if (idx === 0) return;
        const next = rules.slice();
        [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
        callbacks.saveRules(next);
      });
      upBtn.disabled = idx === 0;
      row.appendChild(upBtn);

      const downBtn = makeRowBtn('▼', 'Move down', () => {
        if (idx === rules.length - 1) return;
        const next = rules.slice();
        [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
        callbacks.saveRules(next);
      });
      downBtn.disabled = idx === rules.length - 1;
      row.appendChild(downBtn);

      const editBtn = makeRowBtn('✎', 'Edit', () => {
        closeRulesPopover();
        openRuleModal(callbacks, rule);
      });
      row.appendChild(editBtn);

      const delBtn = makeRowBtn('✕', 'Delete', () => {
        const next = rules.slice();
        next.splice(idx, 1);
        callbacks.saveRules(next);
      });
      row.appendChild(delBtn);

      list.appendChild(row);
    });
    container.appendChild(list);
  }

  const actions = document.createElement('div');
  actions.className = 'cond-fmt-actions';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'cond-fmt-add';
  addBtn.textContent = '+ Add rule';
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeRulesPopover();
    openRuleModal(callbacks, null);
  });
  actions.appendChild(addBtn);

  if (rules.length > 0) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'cond-fmt-clear';
    clearBtn.textContent = 'Clear all';
    clearBtn.title = 'Wipe all rules for this file';
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.saveRules([]);
      closeRulesPopover();
    });
    actions.appendChild(clearBtn);
  }

  container.appendChild(actions);
}

function makeRowBtn(
  label: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cond-fmt-row-btn';
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

// Column names referenced by a parsed AST (for the missing-column indicator).
function columnsFromAst(ast: Expr): string[] {
  const out = new Set<string>();
  const walk = (e: Expr): void => {
    if (e.type === 'column') out.add(e.name);
    else if (e.type === 'unary') walk(e.operand);
    else if (e.type === 'binary') { walk(e.left); walk(e.right); }
    else if (e.type === 'call') { for (const a of e.args) walk(a); }
  };
  walk(ast);
  return [...out];
}

// Append a ⚠ indicator to a rules-list row.
function appendRuleWarning(row: HTMLElement, title: string): void {
  const warn = document.createElement('span');
  warn.className = 'cond-fmt-warning';
  warn.textContent = '⚠';
  warn.title = title;
  row.appendChild(warn);
}

function openRuleModal(
  callbacks: RulesUiCallbacks,
  existing: Rule | null,
): void {
  const owner = callbacks.getActiveUri();
  if (!owner) return;
  const session: ModalSession = {
    existing,
    formula: existing?.formula ?? '',
    color: existing?.color ?? 'yellow',
  };
  modalSessions.set(owner, session);
  mountModal(callbacks, session);
}

// Build and show the modal DOM for a session. Used both when the user first
// opens it (openRuleModal) and when re-showing a preserved session on returning
// to its file (syncRuleModalToActiveKey).
function mountModal(
  callbacks: RulesUiCallbacks,
  session: ModalSession,
): void {
  dismountModal();
  modalOwnerKey = callbacks.getActiveUri();
  const existing = session.existing;

  const backdrop = document.createElement('div');
  backdrop.className = 'cond-fmt-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'cond-fmt-modal';

  const title = document.createElement('div');
  title.className = 'cond-fmt-modal-title';
  title.textContent = existing ? 'Edit rule' : 'New rule';
  // Drag the modal by its title bar. Tracks pointer offset from the modal's
  // top-left and updates left/top on each mousemove. Stays within the
  // viewport bounds so the title bar can't be dragged off-screen.
  makeDraggable(modal, title);
  modal.appendChild(title);

  const editorHost = document.createElement('div');
  editorHost.className = 'cond-fmt-editor-host';
  modal.appendChild(editorHost);

  const status = document.createElement('div');
  status.className = 'cond-fmt-modal-status';
  modal.appendChild(status);

  const colorRow = document.createElement('div');
  colorRow.className = 'cond-fmt-color-row';
  const colorLabel = document.createElement('span');
  colorLabel.className = 'cond-fmt-color-label';
  colorLabel.textContent = 'Color:';
  colorRow.appendChild(colorLabel);
  let selectedColor: RuleColor = session.color;

  for (const c of RULE_COLORS_ORDER) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = `cond-fmt-color-swatch swatch-${c}`;
    sw.title = c;
    if (c === selectedColor) sw.classList.add('selected');
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedColor = c;
      session.color = c;
      colorRow.querySelectorAll('.cond-fmt-color-swatch').forEach((el) => {
        el.classList.remove('selected');
      });
      sw.classList.add('selected');
    });
    colorRow.appendChild(sw);
  }
  modal.appendChild(colorRow);

  const actions = document.createElement('div');
  actions.className = 'cond-fmt-modal-actions';

  const helpBtn = document.createElement('button');
  helpBtn.type = 'button';
  helpBtn.className = 'cond-fmt-help-btn';
  helpBtn.textContent = 'Help';
  helpBtn.title = 'Show function reference';
  helpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleHelpPanel(modal);
  });
  actions.appendChild(helpBtn);

  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  actions.appendChild(spacer);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'cond-fmt-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => closeRuleModal());
  actions.appendChild(cancelBtn);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'cond-fmt-save';
  saveBtn.textContent = existing ? 'Save' : 'Add rule';
  saveBtn.disabled = true;
  actions.appendChild(saveBtn);

  modal.appendChild(actions);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  modalRef = backdrop;

  // Wire Monaco.
  modalEditor = createFormulaEditor(
    editorHost,
    session.formula,
    {
      getColumns: () =>
        callbacks.getColumns().map((c) => ({ field: c.field })),
      onChange: (text) => {
        session.formula = text;
        refreshModalStatus(text, status, saveBtn, callbacks);
      },
      requestClipboardText: callbacks.requestClipboardText,
    },
    callbacks.getResolvedTheme(),
  );

  refreshModalStatus(modalEditor.getValue(), status, saveBtn, callbacks);

  saveBtn.addEventListener('click', () => {
    if (!modalEditor) return;
    const formulaText = modalEditor.getValue().trim();
    if (!formulaText) return;
    // parse() can throw (e.g. RangeError on deep nesting); refreshModalStatus
    // already disables save in that case, but guard the click path too (FORM-2).
    let parsedSave: ReturnType<typeof parse>;
    try {
      parsedSave = parse(formulaText);
    } catch {
      return;
    }
    const { ast, diagnostics } = parsedSave;
    if (!ast || diagnostics.length > 0) return;
    const newRule: Rule = existing
      ? { ...existing, formula: formulaText, color: selectedColor }
      : {
          id: generateId(),
          formula: formulaText,
          color: selectedColor,
          createdAt: Date.now(),
        };
    const rules = callbacks.getRules().slice();
    if (existing) {
      const i = rules.findIndex((r) => r.id === existing.id);
      if (i >= 0) rules[i] = newRule;
      else rules.push(newRule);
    } else {
      rules.push(newRule);
    }
    callbacks.saveRules(rules);
    closeRuleModal();
  });

  modalEscHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // If Monaco has an autocomplete / parameter-hint / find popup open, let
    // Escape dismiss THAT (Monaco handles it on the way down to the editor).
    // Don't close the modal — Escape only rejects the suggestion here.
    if (modalEditor?.isWidgetOpen()) return;
    e.preventDefault();
    closeRuleModal();
  };
  document.addEventListener('keydown', modalEscHandler, true);

  // Focus the editor so the user can start typing immediately.
  setTimeout(() => modalEditor?.focus(), 0);
}

function refreshModalStatus(
  text: string,
  statusEl: HTMLElement,
  saveBtn: HTMLButtonElement,
  callbacks: RulesUiCallbacks,
): void {
  const trimmed = text.trim();
  if (!trimmed) {
    statusEl.textContent = 'Enter a formula to preview matches.';
    statusEl.className = 'cond-fmt-modal-status muted';
    saveBtn.disabled = true;
    return;
  }
  // parse() can throw (e.g. RangeError on a too-deeply-nested formula) rather
  // than returning diagnostics; guard it so the modal never crashes and the
  // save stays blocked (FORM-2).
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(trimmed);
  } catch {
    statusEl.textContent = 'Formula is too complex to evaluate.';
    statusEl.className = 'cond-fmt-modal-status error';
    saveBtn.disabled = true;
    return;
  }
  const { ast, diagnostics } = parsed;
  if (!ast || diagnostics.length > 0) {
    const msg = diagnostics[0]?.message ?? 'Formula has errors.';
    statusEl.textContent = msg;
    statusEl.className = 'cond-fmt-modal-status error';
    saveBtn.disabled = true;
    return;
  }
  const cols = callbacks.getColumns();
  const rows = callbacks.getRows();
  if (cols.length === 0 || rows.length === 0) {
    statusEl.textContent = 'Formula OK. Run a query to preview matches.';
    statusEl.className = 'cond-fmt-modal-status';
    saveBtn.disabled = false;
    return;
  }
  // Aggregations (COUNTIF / COUNTIFS) need the full row set + a per-evaluation
  // cache so the live preview is O(N) not O(N²).
  const ctx = buildContext(cols, {
    allRows: rows,
    countCache: new Map<string, number>(),
  });
  let matchCount = 0;
  let missingColumn: string | null = null;
  let typeMismatch = false;
  let typeMismatchHint: string | null = null;
  for (const r of rows) {
    // An eval throw depends on the AST, not the row, so it would repeat for
    // every row — bail on the first and report it instead of crashing (FORM-2).
    try {
      const { matched, report } = matches(ast, r, ctx);
      if (matched) matchCount++;
      if (report.missingColumn && !missingColumn) missingColumn = report.missingColumnName;
      if (report.typeMismatch) typeMismatch = true;
      if (report.typeMismatchHint && !typeMismatchHint) typeMismatchHint = report.typeMismatchHint;
    } catch {
      statusEl.textContent = 'Formula is too complex to evaluate.';
      statusEl.className = 'cond-fmt-modal-status error';
      saveBtn.disabled = true;
      return;
    }
  }
  if (missingColumn) {
    statusEl.textContent = `Column "${missingColumn}" not in current result — rule will sit idle until a query has it.`;
    statusEl.className = 'cond-fmt-modal-status warning';
    saveBtn.disabled = false;
    return;
  }
  const total = rows.length;
  const word = typeMismatch
    ? (typeMismatchHint ? ` — ${typeMismatchHint}` : ' (type mismatch on some rows)')
    : '';
  statusEl.textContent = `Matches ${matchCount.toLocaleString()} of ${total.toLocaleString()} rows${word}.`;
  statusEl.className = 'cond-fmt-modal-status';
  saveBtn.disabled = false;
}

function toggleHelpPanel(modal: HTMLElement): void {
  if (helpPanelRef && helpPanelRef.parentElement) {
    helpPanelRef.parentElement.removeChild(helpPanelRef);
    helpPanelRef = null;
    modal.classList.remove('with-help');
    return;
  }
  const panel = document.createElement('div');
  panel.className = 'cond-fmt-help-panel';
  panel.appendChild(buildHelpContent());
  modal.classList.add('with-help');
  modal.appendChild(panel);
  helpPanelRef = panel;
}

function buildHelpContent(): HTMLElement {
  const root = document.createElement('div');
  root.className = 'cond-fmt-help-content';

  const title = document.createElement('div');
  title.className = 'cond-fmt-help-title';
  title.textContent = 'Formula language';
  root.appendChild(title);

  const intro = document.createElement('div');
  intro.className = 'cond-fmt-help-intro';
  intro.textContent =
    'Sheets/Excel-style formulas. Reference columns by name; literals use double quotes for strings.';
  root.appendChild(intro);

  // Syntax notes
  const sect1 = document.createElement('div');
  sect1.className = 'cond-fmt-help-section';
  const h1 = document.createElement('div');
  h1.className = 'cond-fmt-help-section-h';
  h1.textContent = 'Syntax';
  sect1.appendChild(h1);
  for (const s of SYNTAX_NOTES) {
    const para = document.createElement('div');
    para.className = 'cond-fmt-help-para';
    const lab = document.createElement('strong');
    lab.textContent = `${s.title}. `;
    para.appendChild(lab);
    para.appendChild(document.createTextNode(s.body));
    sect1.appendChild(para);
  }
  root.appendChild(sect1);

  // Operators
  const sect2 = document.createElement('div');
  sect2.className = 'cond-fmt-help-section';
  const h2 = document.createElement('div');
  h2.className = 'cond-fmt-help-section-h';
  h2.textContent = 'Operators';
  sect2.appendChild(h2);
  for (const op of OPERATORS) {
    const row = document.createElement('div');
    row.className = 'cond-fmt-help-row';
    const sym = document.createElement('code');
    sym.textContent = op.symbol;
    row.appendChild(sym);
    const desc = document.createElement('span');
    desc.textContent = ' ' + op.description;
    row.appendChild(desc);
    sect2.appendChild(row);
  }
  root.appendChild(sect2);

  // Functions
  const sect3 = document.createElement('div');
  sect3.className = 'cond-fmt-help-section';
  const h3 = document.createElement('div');
  h3.className = 'cond-fmt-help-section-h';
  h3.textContent = 'Functions';
  sect3.appendChild(h3);
  for (const fn of FUNCTIONS) {
    const card = document.createElement('div');
    card.className = 'cond-fmt-help-card';
    const sig = document.createElement('code');
    sig.textContent = fn.signature;
    card.appendChild(sig);
    const desc = document.createElement('div');
    desc.className = 'cond-fmt-help-desc';
    desc.textContent = fn.description;
    card.appendChild(desc);
    const ex = document.createElement('div');
    ex.className = 'cond-fmt-help-example';
    const exLbl = document.createElement('span');
    exLbl.className = 'cond-fmt-help-example-lbl';
    exLbl.textContent = 'Example: ';
    ex.appendChild(exLbl);
    const exCode = document.createElement('code');
    exCode.textContent = fn.example;
    ex.appendChild(exCode);
    card.appendChild(ex);
    sect3.appendChild(card);
  }
  root.appendChild(sect3);

  return root;
}

function makeDraggable(modal: HTMLElement, handle: HTMLElement): void {
  handle.classList.add('cond-fmt-drag-handle');

  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let dragging = false;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    e.preventDefault();
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const rect = modal.getBoundingClientRect();
    // Clamp so at least 40px of the title bar remains on-screen.
    const minLeft = -(rect.width - 80);
    const maxLeft = window.innerWidth - 80;
    const minTop = 0;
    const maxTop = window.innerHeight - 40;
    const nextLeft = Math.min(maxLeft, Math.max(minLeft, startLeft + dx));
    const nextTop = Math.min(maxTop, Math.max(minTop, startTop + dy));
    modal.style.left = `${nextLeft}px`;
    modal.style.top = `${nextTop}px`;
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    handle.classList.remove('dragging');
  };

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // First drag: switch from flexbox-centered to absolute-positioned and
    // capture the current visual position so the modal doesn't jump.
    const rect = modal.getBoundingClientRect();
    modal.style.position = 'fixed';
    modal.style.margin = '0';
    modal.style.left = `${rect.left}px`;
    modal.style.top = `${rect.top}px`;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    dragging = true;
    handle.classList.add('dragging');
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    e.preventDefault();
  });
}

// Tear down the modal DOM WITHOUT discarding its saved session — used when the
// modal is hidden because the user switched to another file.
function dismountModal(): void {
  if (modalEditor) {
    modalEditor.dispose();
    modalEditor = null;
  }
  if (modalRef && modalRef.parentElement) {
    modalRef.parentElement.removeChild(modalRef);
  }
  modalRef = null;
  modalOwnerKey = null;
  helpPanelRef = null;
  if (modalEscHandler) {
    document.removeEventListener('keydown', modalEscHandler, true);
    modalEscHandler = null;
  }
}

// Close the modal because the USER dismissed it (Cancel / Save / Escape).
// Discards the saved session so returning to the file opens a fresh modal.
function closeRuleModal(): void {
  const owner = modalOwnerKey;
  dismountModal();
  if (owner) modalSessions.delete(owner);
}

// Show/hide the modal to match the displayed result key. Called whenever the
// active (displayed) file changes: hides the modal (state preserved) when it
// belongs to a different file, and re-shows a saved one when its file becomes
// active again. The caller's getActiveUri() returns the DISPLAYED key, so a
// pinned result keeps its modal on screen regardless of editor focus.
export function syncRuleModalToActiveKey(callbacks: RulesUiCallbacks): void {
  const active = callbacks.getActiveUri();
  if (modalRef) {
    if (modalOwnerKey === active) return;
    dismountModal();
  }
  if (active && modalSessions.has(active)) {
    mountModal(callbacks, modalSessions.get(active) as ModalSession);
  }
}

// Drop any saved modal session for a file that's been closed/dropped, and tear
// down the modal if it's currently showing that file.
export function discardModalSession(uri: string): void {
  modalSessions.delete(uri);
  if (modalOwnerKey === uri) dismountModal();
}

// Re-rendering signal: when rules-changed messages come in, the host may
// have changed the active file's rules. Re-render the popover if it's
// open so the user sees the new state.
export function maybeRefreshRulesPopover(callbacks: RulesUiCallbacks): void {
  if (!rulesPopoverRef) return;
  renderRulesList(rulesPopoverRef, callbacks);
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 10);
  return `r_${ts}_${rnd}`;
}
