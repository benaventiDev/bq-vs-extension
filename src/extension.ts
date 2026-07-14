import * as vscode from 'vscode';
import { ResultViewProvider } from './panel/resultViewProvider';
import { runSelectionCommand } from './commands/runSelection';
import { runFileCommand } from './commands/runFile';
import { RulesStore, isSqlFileUri } from './panel/rules/rulesStore';
import { registerFormatter } from './format/registerFormatter';
import { showSponsorNudgeNow, openSponsorPage } from './sponsor';

/** Extract the document URI a tab points at, if it's a text-like tab. */
function uriFromTab(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) return input.uri;
  if (input instanceof vscode.TabInputTextDiff) return input.modified;
  return undefined;
}

/** True if the given URI is still shown in any open tab (any split/group). */
function isUriOpenInAnyTab(uriString: string): boolean {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const u = uriFromTab(tab);
      if (u && u.toString() === uriString) return true;
    }
  }
  return false;
}

export function activate(context: vscode.ExtensionContext): void {
  const rulesStore = new RulesStore(context);
  const provider = new ResultViewProvider(context, rulesStore);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ResultViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('bqVsExtension.runSelection', () => runSelectionCommand(provider)),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('bqVsExtension.runFile', () => runFileCommand(provider)),
  );

  // M12 — SQL formatter (BigQuery dialect). Registers the
  // DocumentFormattingEditProvider (so Shift+Alt+F / right-click /
  // formatOnSave work) plus a dedicated command + keybinding.
  registerFormatter(context);

  // Sponsor: a "Preview Sponsor Message" command (to see the nudge on demand)
  // and a direct "Sponsor" command (opens GitHub Sponsors). The gentle,
  // usage-gated nudge itself fires from ResultViewProvider after a query.
  context.subscriptions.push(
    vscode.commands.registerCommand('bqVsExtension.previewSponsorNudge', () => showSponsorNudgeNow()),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('bqVsExtension.sponsor', () => openSponsorPage()),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      provider.onActiveEditorChanged(editor);
    }),
  );

  // Drop a file's result slot when its editor TAB is genuinely closed.
  //
  // We deliberately do NOT key off `onDidCloseTextDocument`: VS Code fires
  // that when a *preview* tab is replaced by navigating to another file
  // (the document closes even though the user is just switching files), which
  // would wrongly evict — and, for an in-flight query, kill — the result the
  // moment you click away. The TabGroups API distinguishes the two: a preview
  // replacement is a `changed` event, a real close (✕ / Ctrl+W) is a `closed`
  // event. So results now survive navigation and only drop on an actual close.
  // Drop a file's result when its editor tab is actually closed (✕ / Ctrl+W).
  // Running a query keeps the editor (see runSqlForUri → keepEditor), so any
  // file that has a result is a permanent tab — never silently replaced by
  // preview navigation. That means a `closed` event here is a genuine close.
  // (Un-run preview files that get replaced also fire `closed`, but they have
  // no result slot, so onUriDropped is a no-op for them.)
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.closed) {
        const uri = uriFromTab(tab);
        if (!uri || !isSqlFileUri(uri)) continue;
        // Still shown in another split/group → not really closed.
        if (isUriOpenInAnyTab(uri.toString())) continue;
        provider.onUriDropped(uri);
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles((event) => {
      for (const { oldUri, newUri } of event.files) {
        // Rules follow the rename; the result slot is dropped per
        // [[project-lifecycle-model]] (which treats rename as close+reopen).
        if (isSqlFileUri(oldUri)) {
          void rulesStore.renameUri(oldUri, newUri);
        }
        provider.onUriDropped(oldUri);
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) {
        if (isSqlFileUri(uri)) {
          void rulesStore.deleteForUri(uri);
        }
      }
    }),
  );

}

export function deactivate(): void {
  // nothing
}
