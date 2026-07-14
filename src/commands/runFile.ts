import * as vscode from 'vscode';
import { runSqlForUri } from './runSelection';
import type { ResultViewProvider } from '../panel/resultViewProvider';

export async function runFileCommand(provider: ResultViewProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const doc = editor.document;
  if (doc.uri.scheme !== 'file' || !doc.uri.fsPath.toLowerCase().endsWith('.sql')) {
    return;
  }
  const fileText = doc.getText();
  if (!fileText.trim()) {
    return;
  }

  await runSqlForUri(provider, doc.uri, fileText);
}
