import * as vscode from 'vscode';
import { formatSqlDocument } from './sqlFormatter';

/**
 * M12 — register the SQL formatter with VS Code.
 *
 * Two surfaces:
 *   1. `DocumentFormattingEditProvider` for `language: 'sql'` — wires up
 *      VS Code's standard Format Document path (Shift+Alt+F, right-click,
 *      `editor.formatOnSave`, `editor.defaultFormatter` resolution).
 *   2. `bqVsExtension.formatSql` command — explicit invocation surface
 *      bound to Ctrl+Alt+B (Cmd+Alt+B on macOS) for users who want a
 *      dedicated chord or who have another SQL formatter installed and
 *      want to force ours without changing defaultFormatter.
 *
 * Both surfaces share the same underlying formatSqlDocument() so settings
 * changes apply uniformly.
 */
export function registerFormatter(context: vscode.ExtensionContext): void {
  const providerDisposable = vscode.languages.registerDocumentFormattingEditProvider(
    { language: 'sql' },
    {
      provideDocumentFormattingEdits(
        document: vscode.TextDocument,
        _options: vscode.FormattingOptions,
        token: vscode.CancellationToken,
      ): vscode.TextEdit[] | undefined {
        try {
          return formatSqlDocument(document, token);
        } catch (err) {
          // sql-formatter throws on malformed input. Surface a toast so
          // the user knows nothing happened; return undefined so VS Code
          // does NOT apply a no-op edit (which would dirty the document
          // and add an empty undo entry).
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Format failed: ${msg}`);
          return undefined;
        }
      },
    },
  );
  context.subscriptions.push(providerDisposable);

  const commandDisposable = vscode.commands.registerCommand(
    'bqVsExtension.formatSql',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('Open a SQL file to format.');
        return;
      }
      if (editor.document.languageId !== 'sql') {
        void vscode.window.showWarningMessage(
          'BQ: Format SQL only formats SQL files.',
        );
        return;
      }
      // Call our formatter directly (instead of routing through
      // `editor.action.formatDocument`) so this command always uses OURS
      // even if the user has set a different SQL formatter as their
      // `editor.defaultFormatter`. That's the point of the dedicated
      // command — it's an unambiguous "use the BQ formatter."
      const tokenSource = new vscode.CancellationTokenSource();
      try {
        const edits = formatSqlDocument(editor.document, tokenSource.token);
        if (!edits || edits.length === 0) return;
        await editor.edit((eb) => {
          for (const edit of edits) eb.replace(edit.range, edit.newText);
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Format failed: ${msg}`);
      } finally {
        tokenSource.dispose();
      }
    },
  );
  context.subscriptions.push(commandDisposable);
}
