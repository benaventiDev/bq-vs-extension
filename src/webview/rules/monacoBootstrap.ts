// Monaco loader + formula-language registration.
//
// Why the slim `editor.api.js` entry: importing `editor.main.js` would pull
// in every language Monaco ships with (TypeScript, JSON, HTML, …) plus their
// worker scripts. We need only the editor core + our custom formula
// language, so we use the slim entry and register what we need ourselves.
//
// CSP: the webview enforces `script-src 'nonce-${nonce}'` with no
// `'unsafe-eval'`. Monaco's core doesn't use eval; the only place workers
// would matter is for built-in TypeScript/JSON language services, which we
// don't register. We still install a no-op `MonacoEnvironment.getWorker`
// just in case something downstream asks for a worker.

// Slim Monaco entry: just the editor core + language registration APIs.
// Importing 'monaco-editor' (the package root) would side-effect import
// every bundled language (TS/JSON/HTML/CSS/40+ Monarch syntaxes) and
// inflate the bundle past 10 MB. editor.api.js exposes the same
// `editor` / `languages` namespaces with none of that baggage.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

// Editor contributions. The slim API entry above does NOT include the
// "feels like a real editor" behaviors — word-level navigation, line
// operations, find/replace, bracket matching, clipboard, multi-cursor.
// Each side-effect import registers its commands + default keybindings
// (Ctrl+Shift+Left for word-select, Ctrl+F for find, etc.). Without them
// the editor only supports per-character cursor moves and basic typing.
import 'monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/esm/vs/editor/contrib/caretOperations/browser/caretOperations.js';
import 'monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController.js';
import 'monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo.js';
// The suggest controller: the completion dropdown itself. registerCompletion-
// ItemProvider (below) only registers a provider; without this contribution the
// slim editor has no UI to trigger quick suggestions, query the provider, or
// render/accept the widget — so column/function autocomplete never appears.
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js';
// Hover widget — renders the function-doc HoverProvider registered below
// (without it the provider is registered but never shown, same as suggest was).
import 'monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js';
// Parameter hints — the signature popup shown while typing a function call's
// args (paired with the SignatureHelpProvider registered below).
import 'monaco-editor/esm/vs/editor/contrib/parameterHints/browser/parameterHints.js';
// Snippet controller — lets completions insert placeholder tab-stops so
// accepting a function drops the cursor inside the parens and Tab jumps args.
import 'monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2.js';

import { FUNCTIONS, findFunctionDoc } from '../../formula/docs';
import { parse } from '../../formula/parser';
import { tokenize } from '../../formula/lexer';

let registered = false;

export const FORMULA_LANG_ID = 'bq-formula';

export function ensureMonacoBootstrapped(): void {
  if (registered) return;
  registered = true;

  // Monaco may ask for a worker for unrelated reasons (e.g. editor base
  // services). CSP would block any cross-origin worker script, so we
  // synthesise an in-line no-op worker from a blob: URL. The webview's CSP
  // doesn't list a worker-src, so default-src 'none' would block this — but
  // the typical CSP for VS Code webviews allows blob: workers. If the
  // worker is never used by code paths we register, no script actually
  // runs inside it.
  if (typeof window !== 'undefined') {
    const NOOP_WORKER_SRC = 'self.onmessage = () => {};';
    let workerUrl: string | null = null;
    const makeUrl = () => {
      if (workerUrl !== null) return workerUrl;
      const blob = new Blob([NOOP_WORKER_SRC], { type: 'application/javascript' });
      workerUrl = URL.createObjectURL(blob);
      return workerUrl;
    };
    (window as Window & typeof globalThis).MonacoEnvironment = {
      getWorker: () => {
        try {
          return new Worker(makeUrl());
        } catch {
          // Fall back to a stub that satisfies the Worker interface but
          // does nothing. Monaco's standalone editor doesn't actually use
          // workers for our registered languages.
          return new Worker(
            URL.createObjectURL(new Blob([NOOP_WORKER_SRC], { type: 'application/javascript' })),
          );
        }
      },
    };
  }

  monaco.languages.register({ id: FORMULA_LANG_ID });

  // Monarch tokenizer — keywords/functions/operators get distinct token
  // classes so VS Code's default token-color theme renders them naturally.
  monaco.languages.setMonarchTokensProvider(FORMULA_LANG_ID, {
    defaultToken: '',
    tokenPostfix: '.bqformula',
    ignoreCase: true,
    keywords: ['AND', 'OR', 'NOT', 'TRUE', 'FALSE', 'NULL'],
    functions: FUNCTIONS.map((f) => f.name),
    operators: ['=', '<>', '<', '<=', '>', '>=', '+', '-', '*', '/'],
    symbols: /[=<>!+\-*/]+/,
    tokenizer: {
      root: [
        // Identifiers / keywords / function names — case-insensitive
        [
          /[A-Za-z_][\w]*/,
          {
            cases: {
              '@keywords': 'keyword',
              '@functions': 'predefined',
              '@default': 'identifier',
            },
          },
        ],
        // Whitespace
        { include: '@whitespace' },
        // Punctuation
        [/[()]/, '@brackets'],
        [/,/, 'delimiter'],
        // Numbers — kept in step with the lexer (lexer.ts number rule), which
        // requires a leading digit and accepts an exponent with or without a
        // fractional part. Float (with dot) first, then exponent-without-dot
        // (e.g. 1e3), then plain integer (FORM-8).
        [/\d+\.\d*([eE][+-]?\d+)?/, 'number.float'],
        [/\d+[eE][+-]?\d+/, 'number'],
        [/\d+/, 'number'],
        // Backtick-quoted column reference — colored as an identifier so it
        // reads like the bare column refs it's equivalent to.
        [/`[^`]+`/, 'identifier'],
        [/`/, { token: 'string.invalid' }],
        // Strings (double- or single-quoted; doubled-quote = escape)
        [/"([^"]|"")*"/, 'string'],
        [/'([^']|'')*'/, 'string'],
        [/["']/, { token: 'string.invalid' }],
        // Operators
        [
          /@symbols/,
          {
            cases: {
              '@operators': 'operator',
              '@default': '',
            },
          },
        ],
      ],
      whitespace: [[/[ \t\r\n]+/, 'white']],
    },
  });

  monaco.languages.setLanguageConfiguration(FORMULA_LANG_ID, {
    brackets: [['(', ')']],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '`', close: '`' },
    ],
    surroundingPairs: [
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '`', close: '`' },
    ],
  });
}

export interface ColumnSuggestion {
  field: string;
}

export interface FormulaEditorCallbacks {
  getColumns: () => ColumnSuggestion[];
  onChange: (text: string) => void;
  // Routes Monaco's Ctrl+V through the extension host so the OS clipboard
  // is reachable. Webviews block navigator.clipboard.readText(), and
  // Monaco's clipboard contrib has no fallback that works there.
  requestClipboardText: () => Promise<string>;
}

// The completion / hover providers are registered ONCE for the language (the
// correct Monaco pattern — they live for the webview's lifetime, not per
// editor). They read columns through this module-level hook. Only one rule
// modal exists at a time (openRuleModal closes any existing one first), and
// createFormulaEditor sets this before creating its editor and nulls it on
// dispose, so the hook always reflects the active editor (FORM-7).
let columnsProvider: (() => ColumnSuggestion[]) | null = null;
let providersInstalled = false;

// Extract parameter labels from a doc signature, e.g.
// "COUNTIF(column_ref, criterion)" -> ["column_ref", "criterion"].
function signatureParams(signature: string): string[] {
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const inner = signature.slice(open + 1, close).trim();
  if (!inner) return [];
  return inner.split(',').map((p) => p.trim()).filter(Boolean);
}

// Build a snippet insert for a function: `COUNTIF(${1:column_ref}, ${2:criterion})`
// so accepting it lands the cursor on the first argument and Tab cycles them.
// (No-arg functions like TODAY() just insert `TODAY()`.)
function snippetFor(fn: { name: string; signature: string }): string {
  const params = signatureParams(fn.signature);
  if (params.length === 0) return fn.name + '()';
  const body = params.map((p, i) => '${' + (i + 1) + ':' + p + '}').join(', ');
  return fn.name + '(' + body + ')';
}

// Best-effort: find the innermost function call the cursor is inside and which
// argument (0-based) it's in. Tolerates incomplete input (mid-typing) and skips
// string / backtick contents so their parens and commas don't count.
function enclosingCall(text: string): { name: string; argIndex: number } | null {
  const stack: { name: string | null; argIndex: number }[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < text.length) {
        if (text[i] === q) {
          if (text[i + 1] === q) { i += 2; continue; } // doubled-quote escape
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '`') {
      i++;
      while (i < text.length && text[i] !== '`') i++;
      if (i < text.length) i++;
      continue;
    }
    if (c === '(') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(text[j])) j--;
      const end = j;
      while (j >= 0 && /[A-Za-z0-9_]/.test(text[j])) j--;
      const ident = text.slice(j + 1, end + 1).toUpperCase();
      stack.push({ name: ident && findFunctionDoc(ident) ? ident : null, argIndex: 0 });
      i++;
      continue;
    }
    if (c === ')') { stack.pop(); i++; continue; }
    if (c === ',') { if (stack.length) stack[stack.length - 1].argIndex++; i++; continue; }
    i++;
  }
  for (let k = stack.length - 1; k >= 0; k--) {
    if (stack[k].name) return { name: stack[k].name as string, argIndex: stack[k].argIndex };
  }
  return null;
}

function installLanguageProviders(): void {
  if (providersInstalled) return;
  providersInstalled = true;

  monaco.languages.registerCompletionItemProvider(FORMULA_LANG_ID, {
    triggerCharacters: ['(', ',', ' '],
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );

      const suggestions: monaco.languages.CompletionItem[] = [];

      // Functions — inserted as a snippet so the cursor lands on the first arg
      // and Tab cycles through the rest.
      for (const fn of FUNCTIONS) {
        suggestions.push({
          label: fn.name,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: snippetFor(fn),
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: {
            value: `**${fn.signature}**\n\n${fn.description}\n\nExample: \`${fn.example}\``,
          },
          detail: fn.signature,
          range,
        });
      }

      // Keywords / boolean / null literals
      for (const kw of ['AND', 'OR', 'NOT', 'TRUE', 'FALSE', 'NULL']) {
        suggestions.push({
          label: kw,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: kw,
          range,
        });
      }

      // Columns from the current result. Names that aren't valid bare
      // identifiers are inserted backtick-quoted (BigQuery identifier syntax),
      // matching how the user references the column in their SQL.
      const cols = columnsProvider ? columnsProvider() : [];
      for (const c of cols) {
        const needsQuotes = !/^[A-Za-z_][\w]*$/.test(c.field);
        const insertText = needsQuotes
          ? '`' + c.field.replace(/`/g, '``') + '`'
          : c.field;
        suggestions.push({
          label: c.field,
          kind: monaco.languages.CompletionItemKind.Field,
          insertText,
          detail: 'column',
          range,
        });
      }

      return { suggestions };
    },
  });

  monaco.languages.registerHoverProvider(FORMULA_LANG_ID, {
    provideHover: (model, position) => {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const upper = word.word.toUpperCase();
      const fn = findFunctionDoc(upper);
      if (fn) {
        return {
          range: new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn,
          ),
          contents: [
            { value: `**${fn.signature}**` },
            { value: fn.description },
            { value: `Example: \`${fn.example}\`` },
          ],
        };
      }
      // Operator hover wouldn't trigger on single-symbol tokens; skipping.
      return null;
    },
  });

  // Signature help — while typing inside a function call, show its signature
  // with the active argument highlighted (updates as you pass commas).
  monaco.languages.registerSignatureHelpProvider(FORMULA_LANG_ID, {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    provideSignatureHelp: (model, position) => {
      const textToCursor = model.getValue().slice(0, model.getOffsetAt(position));
      const call = enclosingCall(textToCursor);
      if (!call) return null;
      const fn = findFunctionDoc(call.name);
      if (!fn) return null;
      const params = signatureParams(fn.signature);
      const activeParameter = params.length ? Math.min(call.argIndex, params.length - 1) : 0;
      return {
        value: {
          signatures: [
            {
              label: fn.signature,
              documentation: { value: fn.description },
              parameters: params.map((p) => ({ label: p })),
            },
          ],
          activeSignature: 0,
          activeParameter,
        },
        dispose: () => {},
      };
    },
  });
}

// Non-blocking discoverability hint. A string literal (`"x"` / `'x'`) whose
// content exactly matches a column name in the current result is almost always
// a mistake — the user meant to reference the column, not compare against the
// literal text. Suggest the backtick form. Info severity only: never blocks
// saving (save-gating reads parse() error diagnostics, not these markers).
function computeColumnLiteralHints(
  text: string,
): { start: number; end: number; message: string }[] {
  const cols = columnsProvider ? columnsProvider() : [];
  if (cols.length === 0) return [];
  const byLower = new Map<string, string>();
  for (const c of cols) byLower.set(c.field.toLowerCase(), c.field);
  let tokens: ReturnType<typeof tokenize>;
  try {
    tokens = tokenize(text);
  } catch {
    // Lex error — the parser's error markers already cover the problem.
    return [];
  }
  const hints: { start: number; end: number; message: string }[] = [];
  for (const t of tokens) {
    if (t.type !== 'string') continue;
    const match = byLower.get(t.value.toLowerCase());
    if (match === undefined) continue;
    hints.push({
      start: t.start,
      end: t.end,
      message:
        `"${t.value}" is a string literal, not a column reference. ` +
        `To reference the column ${match}, use backticks: \`${match}\`.`,
    });
  }
  return hints;
}

function refreshMarkers(model: monaco.editor.ITextModel): void {
  const text = model.getValue();
  if (!text.trim()) {
    monaco.editor.setModelMarkers(model, 'bq-formula', []);
    return;
  }
  const { diagnostics } = parse(text);
  const markers: monaco.editor.IMarkerData[] = diagnostics.map((d) => {
    const startPos = model.getPositionAt(d.start);
    const endPos = model.getPositionAt(Math.max(d.end, d.start + 1));
    return {
      message: d.message,
      severity: monaco.MarkerSeverity.Error,
      startLineNumber: startPos.lineNumber,
      startColumn: startPos.column,
      endLineNumber: endPos.lineNumber,
      endColumn: endPos.column,
    };
  });
  // Append non-blocking info hints (e.g. string literal that names a column).
  for (const h of computeColumnLiteralHints(text)) {
    const startPos = model.getPositionAt(h.start);
    const endPos = model.getPositionAt(Math.max(h.end, h.start + 1));
    markers.push({
      message: h.message,
      severity: monaco.MarkerSeverity.Info,
      startLineNumber: startPos.lineNumber,
      startColumn: startPos.column,
      endLineNumber: endPos.lineNumber,
      endColumn: endPos.column,
    });
  }
  monaco.editor.setModelMarkers(model, 'bq-formula', markers);
}

export interface FormulaEditorHandle {
  getValue: () => string;
  setValue: (text: string) => void;
  focus: () => void;
  dispose: () => void;
  layout: () => void;
  // True when a Monaco popup that Escape should dismiss (autocomplete
  // suggestions, parameter hints, or the find widget) is currently open. The
  // modal's Esc handler consults this so Escape closes the popup first,
  // instead of closing the whole rule modal.
  isWidgetOpen: () => boolean;
}

export function createFormulaEditor(
  host: HTMLElement,
  initialText: string,
  callbacks: FormulaEditorCallbacks,
  theme: 'light' | 'dark',
): FormulaEditorHandle {
  ensureMonacoBootstrapped();
  columnsProvider = callbacks.getColumns;
  installLanguageProviders();

  const editor = monaco.editor.create(host, {
    value: initialText,
    language: FORMULA_LANG_ID,
    theme: theme === 'dark' ? 'vs-dark' : 'vs',
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: 'off',
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: 4,
    lineNumbersMinChars: 0,
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    scrollbar: { vertical: 'hidden', horizontalScrollbarSize: 6 },
    renderLineHighlight: 'none',
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    fontSize: 13,
    padding: { top: 6, bottom: 6 },
    contextmenu: false,
    fixedOverflowWidgets: true,
  });

  const model = editor.getModel();
  const disposables: monaco.IDisposable[] = [];
  if (model) {
    refreshMarkers(model);
    disposables.push(
      model.onDidChangeContent(() => {
        refreshMarkers(model);
        callbacks.onChange(model.getValue());
      }),
    );
  }

  // Override Ctrl+V to route through the host. Monaco's own clipboard
  // contrib calls navigator.clipboard.readText() which webviews block;
  // without this the keystroke fires the (broken) command and nothing
  // gets pasted. We replace the selection with the host-provided text
  // via executeEdits so undo history stays intact.
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, () => {
    void callbacks.requestClipboardText().then((text) => {
      if (!text) return;
      const sel = editor.getSelection();
      const range = sel ?? new monaco.Range(1, 1, 1, 1);
      editor.executeEdits('host-paste', [
        { range, text, forceMoveMarkers: true },
      ]);
      editor.pushUndoStop();
    });
  });

  return {
    getValue: () => editor.getValue(),
    setValue: (t) => editor.setValue(t),
    focus: () => editor.focus(),
    layout: () => editor.layout(),
    // With fixedOverflowWidgets the suggest / parameter-hint popups render in
    // an overflow node on <body> (not inside the editor), so we check the
    // document. A visible one means Escape should dismiss it, not the modal.
    isWidgetOpen: () =>
      !!document.querySelector(
        '.suggest-widget.visible, .parameter-hints-widget.visible, .find-widget.visible',
      ),
    dispose: () => {
      for (const d of disposables) d.dispose();
      if (model) {
        monaco.editor.setModelMarkers(model, 'bq-formula', []);
      }
      editor.dispose();
      // Drop the stale closure so the (once-registered) providers don't retain
      // a disposed editor's callbacks (FORM-7). The next createFormulaEditor
      // sets it again; only one modal is ever open at a time.
      columnsProvider = null;
    },
  };
}

export function setMonacoTheme(theme: 'light' | 'dark'): void {
  monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
}
