import * as vscode from 'vscode';
import * as path from 'path';
import { buildHtml } from './html';
import { RulesStore } from './rules/rulesStore';
import { maybeShowSponsorNudge } from '../sponsor';
import type {
  HostToWebviewMessage,
  NestedRenderMode,
  ResolvedTheme,
  TabResult,
  TabState,
  ThemePreference,
  WebviewToHostMessage,
} from './types';

export interface RunHandle {
  promise: Promise<TabResult>;
  cancel: () => void;
}

interface InFlight {
  cancel: () => void;
  cancelled: boolean;
}

const THEME_PREF_KEY = 'bqVsExtension.themePreference';
const HIGHLIGHT_MODE_KEY = 'bqVsExtension.highlightModeEnabled';
const NESTED_RENDER_MODE_KEY = 'bqVsExtension.nestedRenderMode';
const PANEL_ZOOM_KEY = 'bqVsExtension.panelZoom';
// Range expanded to 30–250 to support the manual-input field added in the
// M11 follow-up. +/- buttons in the webview still step by 25, but the
// input accepts any integer in range. Host-side guard for inbound messages.
const PANEL_ZOOM_MIN = 30;
const PANEL_ZOOM_MAX = 250;
const PANEL_ZOOM_DEFAULT = 100;

// How long the export confirmation notification stays before auto-dismissing.
// Long enough to read "Copied N rows" without forcing the user to click ×.
const EXPORT_TOAST_SECONDS = 4;

/**
 * Integer-clamp into the [PANEL_ZOOM_MIN, PANEL_ZOOM_MAX] window. No
 * snapping to 25%-steps — the webview's manual input field accepts any
 * integer in range, and snapping here would silently rewrite user-typed
 * values on every host echo. Webview UI does its own clamp; this is
 * defence in depth against bad inbound messages.
 */
function clampZoom(n: number): number {
  if (!Number.isFinite(n)) return PANEL_ZOOM_DEFAULT;
  const int = Math.trunc(n);
  if (int < PANEL_ZOOM_MIN) return PANEL_ZOOM_MIN;
  if (int > PANEL_ZOOM_MAX) return PANEL_ZOOM_MAX;
  return int;
}

function exportSaveFilters(format: 'csv' | 'xlsx' | 'json'): { [name: string]: string[] } {
  switch (format) {
    case 'csv':
      return { 'CSV files': ['csv'], 'All files': ['*'] };
    case 'xlsx':
      return { 'Excel files': ['xlsx'], 'All files': ['*'] };
    case 'json':
      return { 'JSON files': ['json'], 'All files': ['*'] };
  }
}

export class ResultViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'bqVsExtension.resultPanel';

  private view: vscode.WebviewView | undefined;
  private readonly tabs = new Map<string, TabState>();
  private readonly inFlight = new Map<string, InFlight>();
  private activeKey: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly rulesStore: RulesStore,
  ) {
    const editor = vscode.window.activeTextEditor;
    this.activeKey = this.keyForEditor(editor);

    context.subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (this.getThemePreference() === 'system') {
          this.postCurrentTheme();
        }
      }),
    );

    context.subscriptions.push(
      this.rulesStore.onDidChange((e) => {
        this.post({ type: 'rules-changed', uri: e.uri, rules: e.rules });
      }),
    );
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview')],
    };
    webviewView.webview.html = buildHtml(webviewView.webview, this.context.extensionUri);

    webviewView.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
      this.handleWebviewMessage(msg);
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  public async runForUri(uri: vscode.Uri, start: () => RunHandle): Promise<void> {
    await this.revealPanel();
    const key = uri.toString();

    // Kill any in-flight query for this file. The old run's await below will
    // still resolve (kill -> close event), but its handle.cancelled flag will
    // be set, so its result is discarded.
    const prior = this.inFlight.get(key);
    if (prior) {
      prior.cancelled = true;
      prior.cancel();
    }

    const basename = path.basename(uri.fsPath);
    const tooltip = uri.fsPath;
    const runningTab: TabState = {
      key,
      basename,
      tooltip,
      result: { kind: 'running' },
    };
    this.tabs.set(key, runningTab);
    this.activeKey = key;
    this.postTabUpdate(runningTab);
    this.postSetActive(key);

    // A brand-new tab needs its persisted rules pushed to the webview
    // explicitly — the per-file lifecycle wipes the webview's in-memory
    // rules map on reload, so the popover would otherwise show empty
    // even when workspaceState has rules for this URI.
    this.post({
      type: 'rules-changed',
      uri: key,
      rules: this.rulesStore.get(key),
    });

    const handle = start();
    const inFlight: InFlight = { cancel: handle.cancel, cancelled: false };
    this.inFlight.set(key, inFlight);

    const result = await handle.promise;

    // If this run was cancelled (button, file close, or replaced by a newer
    // run for the same file), drop the result silently.
    if (inFlight.cancelled) {
      return;
    }
    // Only clear the in-flight slot if it still belongs to *this* run.
    if (this.inFlight.get(key) === inFlight) {
      this.inFlight.delete(key);
    }

    const existing = this.tabs.get(key);
    if (!existing) {
      // file closed mid-flight; slot already dropped
      return;
    }
    const updated: TabState = { ...existing, result };
    this.tabs.set(key, updated);
    this.postTabUpdate(updated);

    // A completed query is the natural, non-disruptive moment to (very
    // occasionally) surface the sponsor nudge. Only successful runs count.
    const succeeded = result.kind === 'ok' || result.kind === 'multi';
    void maybeShowSponsorNudge(this.context, succeeded);
  }

  public onActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
    const key = this.keyForEditor(editor);
    this.activeKey = key;
    // Push rules for the (possibly new) active file even if no tab exists
    // yet — the conditional-formatting button needs to reflect rule state
    // before the first Shift+Enter.
    const liveUri = this.liveActiveSqlUri(editor);
    if (liveUri) {
      const rules = this.rulesStore.get(liveUri);
      this.post({ type: 'rules-changed', uri: liveUri.toString(), rules });
    }
    this.postSetActive(key);
  }

  private liveActiveSqlUri(editor: vscode.TextEditor | undefined): vscode.Uri | null {
    if (!editor) return null;
    const uri = editor.document.uri;
    if (uri.scheme !== 'file' || !uri.fsPath.toLowerCase().endsWith('.sql')) return null;
    return uri;
  }

  public onUriDropped(uri: vscode.Uri): void {
    const key = uri.toString();
    this.killInFlight(key);
    if (!this.tabs.has(key)) {
      return;
    }
    this.tabs.delete(key);
    if (this.activeKey === key) {
      this.activeKey = this.keyForEditor(vscode.window.activeTextEditor);
    }
    this.postTabDrop(key);
    this.postSetActive(this.activeKey);
  }

  private killInFlight(key: string): void {
    const inFlight = this.inFlight.get(key);
    if (!inFlight) {
      return;
    }
    inFlight.cancelled = true;
    inFlight.cancel();
    this.inFlight.delete(key);
  }

  private cancelForKey(key: string): void {
    if (!this.inFlight.has(key)) {
      // Race: process already exited between the user clicking cancel and the
      // message reaching the host. Nothing to do.
      return;
    }
    this.killInFlight(key);
    if (!this.tabs.has(key)) {
      return;
    }
    this.tabs.delete(key);
    if (this.activeKey === key) {
      this.activeKey = this.keyForEditor(vscode.window.activeTextEditor);
    }
    this.postTabDrop(key);
    this.postSetActive(this.activeKey);
  }

  private keyForEditor(editor: vscode.TextEditor | undefined): string | null {
    if (!editor) {
      return null;
    }
    const uri = editor.document.uri;
    if (uri.scheme !== 'file' || !uri.fsPath.toLowerCase().endsWith('.sql')) {
      return null;
    }
    const key = uri.toString();
    return this.tabs.has(key) ? key : null;
  }

  private async revealPanel(): Promise<void> {
    try {
      await vscode.commands.executeCommand(`${ResultViewProvider.viewType}.focus`);
    } catch {
      // view may not be focusable yet; ignore
    }
  }

  private getThemePreference(): ThemePreference {
    const stored = this.context.workspaceState.get<unknown>(THEME_PREF_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
    return 'system';
  }

  private resolveTheme(preference: ThemePreference): ResolvedTheme {
    if (preference === 'light') return 'light';
    if (preference === 'dark') return 'dark';
    const kind = vscode.window.activeColorTheme.kind;
    if (
      kind === vscode.ColorThemeKind.Light ||
      kind === vscode.ColorThemeKind.HighContrastLight
    ) {
      return 'light';
    }
    return 'dark';
  }

  private postCurrentTheme(): void {
    const preference = this.getThemePreference();
    const resolved = this.resolveTheme(preference);
    this.post({ type: 'theme-changed', resolved, preference });
  }

  private getHighlightModeEnabled(): boolean {
    return this.context.workspaceState.get<boolean>(HIGHLIGHT_MODE_KEY, false);
  }

  private postCurrentHighlightMode(): void {
    this.post({
      type: 'highlight-mode-changed',
      enabled: this.getHighlightModeEnabled(),
    });
  }

  private getNestedRenderMode(): NestedRenderMode {
    const stored = this.context.workspaceState.get<unknown>(NESTED_RENDER_MODE_KEY);
    return stored === 'explode' ? 'explode' : 'inline';
  }

  private postCurrentRenderMode(): void {
    this.post({ type: 'render-mode-changed', mode: this.getNestedRenderMode() });
  }

  private getPanelZoom(): number {
    const stored = this.context.workspaceState.get<unknown>(PANEL_ZOOM_KEY);
    if (typeof stored !== 'number' || !Number.isFinite(stored)) return PANEL_ZOOM_DEFAULT;
    return clampZoom(stored);
  }

  private postCurrentPanelZoom(): void {
    this.post({ type: 'panel-zoom-changed', zoom: this.getPanelZoom() });
  }

  private handleWebviewMessage(msg: WebviewToHostMessage): void {
    switch (msg.type) {
      case 'ready':
        for (const tab of this.tabs.values()) {
          this.postTabUpdate(tab);
          // Send rules for every tab the webview will be aware of, so the
          // rules popup has correct state regardless of which file becomes
          // active first.
          const rules = this.rulesStore.get(tab.key);
          this.post({ type: 'rules-changed', uri: tab.key, rules });
        }
        // Also send rules for the live active SQL editor even when no tab
        // exists for it yet — covers reload where tabs are empty but the
        // user's editor is already focused on a rule-bearing .sql file.
        // (this.activeKey is gated by tabs and would be null in that case.)
        {
          const live = this.liveActiveSqlUri(vscode.window.activeTextEditor);
          if (live) {
            const rules = this.rulesStore.get(live);
            this.post({ type: 'rules-changed', uri: live.toString(), rules });
          }
        }
        this.postSetActive(this.activeKey);
        this.postCurrentTheme();
        this.postCurrentHighlightMode();
        this.postCurrentRenderMode();
        this.postCurrentPanelZoom();
        break;
      case 'close-tab':
        if (this.tabs.delete(msg.key)) {
          this.killInFlight(msg.key);
          if (this.activeKey === msg.key) {
            this.activeKey = this.keyForEditor(vscode.window.activeTextEditor);
          }
          this.postTabDrop(msg.key);
          this.postSetActive(this.activeKey);
        }
        break;
      case 'cancel':
        this.cancelForKey(msg.key);
        break;
      case 'set-theme-preference': {
        const next: ThemePreference =
          msg.preference === 'light' || msg.preference === 'dark' || msg.preference === 'system'
            ? msg.preference
            : 'system';
        void this.context.workspaceState.update(THEME_PREF_KEY, next).then(() => {
          this.postCurrentTheme();
        });
        break;
      }
      case 'set-highlight-mode': {
        const enabled = msg.enabled === true;
        void this.context.workspaceState.update(HIGHLIGHT_MODE_KEY, enabled).then(() => {
          this.postCurrentHighlightMode();
        });
        break;
      }
      case 'set-render-mode': {
        const next: NestedRenderMode = msg.mode === 'explode' ? 'explode' : 'inline';
        void this.context.workspaceState.update(NESTED_RENDER_MODE_KEY, next).then(() => {
          this.postCurrentRenderMode();
        });
        break;
      }
      case 'set-panel-zoom': {
        const next = clampZoom(msg.zoom);
        void this.context.workspaceState.update(PANEL_ZOOM_KEY, next).then(() => {
          // Echo back so the webview converges on the host-canonical value
          // (defends against the webview ever drifting out of range).
          this.postCurrentPanelZoom();
        });
        break;
      }
      case 'save-rules': {
        // The webview is the source of truth for the rule list (it owns the
        // popup UI). Just persist what came in; the store's onDidChange
        // listener will echo back to the webview, which is harmless because
        // the webview compares against its current state.
        void this.rulesStore.set(msg.uri, msg.rules);
        break;
      }
      case 'request-clipboard': {
        // VS Code webviews block navigator.clipboard.readText(), so
        // Monaco's Ctrl+V can't read the OS clipboard directly. Route
        // through the extension host, which has full access via
        // vscode.env.clipboard. Echo the text back with the same requestId
        // so the webview can resolve the right pending paste.
        const requestId = msg.requestId;
        void vscode.env.clipboard.readText().then(
          (text) => {
            this.post({ type: 'clipboard-text', requestId, text });
          },
          () => {
            this.post({ type: 'clipboard-text', requestId, text: '' });
          },
        );
        break;
      }
      case 'export-save': {
        void this.handleExportSave(msg);
        break;
      }
      case 'export-clipboard': {
        void this.handleExportClipboard(msg);
        break;
      }
      case 'copy-cells': {
        void this.handleCopyCells(msg);
        break;
      }
    }
  }

  /**
   * Handle a webview-originated file-save export. Webview built the payload
   * (CSV/JSON text, or .xlsx bytes); we show the save dialog and write the
   * file. Posts back an export-complete with the outcome so the webview can
   * surface a toast.
   */
  private async handleExportSave(msg: {
    requestId: string;
    format: 'csv' | 'xlsx' | 'json';
    defaultFilename: string;
    content: string | Uint8Array;
  }): Promise<void> {
    const filters = exportSaveFilters(msg.format);
    let uri: vscode.Uri | undefined;
    try {
      const defaultUri = this.defaultSaveUri(msg.defaultFilename);
      uri = await vscode.window.showSaveDialog({
        defaultUri,
        filters,
        saveLabel: 'Export',
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.post({
        type: 'export-complete',
        requestId: msg.requestId,
        ok: false,
        error,
        kind: 'save',
      });
      return;
    }
    if (!uri) {
      // User cancelled the save dialog. Not an error — the webview
      // surfaces a neutral / no-op state for this.
      this.post({
        type: 'export-complete',
        requestId: msg.requestId,
        ok: false,
        kind: 'cancelled',
      });
      return;
    }
    try {
      const bytes =
        typeof msg.content === 'string'
          ? Buffer.from(msg.content, 'utf8')
          : Buffer.from(msg.content);
      await vscode.workspace.fs.writeFile(uri, bytes);
      this.post({
        type: 'export-complete',
        requestId: msg.requestId,
        ok: true,
        filename: path.basename(uri.fsPath),
        kind: 'save',
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.post({
        type: 'export-complete',
        requestId: msg.requestId,
        ok: false,
        error,
        kind: 'save',
      });
    }
  }

  /**
   * Show a confirmation that auto-dismisses after EXPORT_TOAST_SECONDS with no
   * × to click. We use a status-bar message rather than a progress
   * notification: the latter renders a filling progress bar, which reads as
   * "wait for this to finish" — misleading for a result that's already done.
   * The status-bar message just fades on its own. $(check) gives a clear
   * done cue.
   */
  private showAutoDismissInfo(message: string): void {
    vscode.window.setStatusBarMessage(`$(check) ${message}`, EXPORT_TOAST_SECONDS * 1000);
  }

  /**
   * Write a Sheets-style cell-range selection (TSV) to the OS clipboard and
   * show a brief status-bar confirmation. Unlike handleExportClipboard this is
   * fire-and-forget (no requestId echo) and shows no notification toast — a
   * Ctrl+C over cells should feel as quiet as it does in a spreadsheet.
   */
  private async handleCopyCells(msg: {
    text: string;
    rows: number;
    cols: number;
  }): Promise<void> {
    try {
      await vscode.env.clipboard.writeText(msg.text);
      const { rows, cols } = msg;
      const label = rows * cols === 1 ? '1 cell' : `${rows}×${cols} cells`;
      this.showAutoDismissInfo(`Copied ${label}.`);
    } catch {
      // Clipboard write can reject if the OS denies access; stay silent —
      // nothing depends on the outcome and the user can simply retry.
    }
  }

  private async handleExportClipboard(msg: {
    requestId: string;
    text: string;
    rowCount: number;
  }): Promise<void> {
    try {
      await vscode.env.clipboard.writeText(msg.text);
      // Surface a VS Code information toast so the user gets confirmation
      // independent of where they're looking — the inline footer status is
      // easy to miss, especially when the bottom panel is short.
      const n = msg.rowCount;
      this.showAutoDismissInfo(
        `Copied ${n.toLocaleString()} row${n === 1 ? '' : 's'} to clipboard.`,
      );
      this.post({
        type: 'export-complete',
        requestId: msg.requestId,
        ok: true,
        kind: 'clipboard',
        rowCount: msg.rowCount,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Copy to clipboard failed: ${error}`);
      this.post({
        type: 'export-complete',
        requestId: msg.requestId,
        ok: false,
        error,
        kind: 'clipboard',
      });
    }
  }

  /**
   * Pick a sensible defaultUri for the save dialog: workspace folder + the
   * suggested filename. The user can override in the dialog. If there is
   * no workspace folder we let VS Code default to the last-used location.
   */
  private defaultSaveUri(filename: string): vscode.Uri | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    return vscode.Uri.joinPath(folders[0].uri, filename);
  }

  private postTabUpdate(tab: TabState): void {
    this.post({ type: 'tab-update', tab });
  }

  private postTabDrop(key: string): void {
    this.post({ type: 'tab-drop', key });
  }

  private postSetActive(key: string | null): void {
    // Also tell the webview which live .sql editor is focused (even when it
    // has no result slot) so the pin-mismatch banner can name it. Computed
    // here from the current active editor so every postSetActive call site
    // stays a one-liner.
    const live = this.liveActiveSqlUri(vscode.window.activeTextEditor);
    this.post({
      type: 'set-active',
      key,
      activeEditorKey: live ? live.toString() : null,
    });
  }

  private post(msg: HostToWebviewMessage): void {
    this.view?.webview.postMessage(msg);
  }
}
