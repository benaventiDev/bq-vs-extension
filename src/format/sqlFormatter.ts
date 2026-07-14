import * as vscode from 'vscode';
import { format as sqlFormatterFormat } from 'sql-formatter';

/**
 * M12 — BigQuery-dialect SQL formatter. Reads the user's settings every
 * call (no caching) so changes take effect immediately without a window
 * reload. Returns a single TextEdit covering the entire document, or an
 * empty array when the formatted output matches the input — avoids
 * polluting the undo stack with no-op edits.
 *
 * Throws (the caller decides how to surface it). sql-formatter throws on
 * a small set of malformed inputs; everything else round-trips, even
 * obviously invalid SQL.
 */

type KeywordCase = 'upper' | 'lower' | 'preserve';

interface FormatSettings {
  keywordCase: KeywordCase;
  indentSize: number;
  expressionWidth: number;
  linesBetweenQueries: number;
}

const SETTINGS_NAMESPACE = 'bqVsExtension.format';

const DEFAULTS: FormatSettings = {
  keywordCase: 'upper',
  indentSize: 2,
  expressionWidth: 100,
  linesBetweenQueries: 2,
};

function readSettings(): FormatSettings {
  const cfg = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE);
  const raw = {
    keywordCase: cfg.get<unknown>('keywordCase'),
    indentSize: cfg.get<unknown>('indentSize'),
    expressionWidth: cfg.get<unknown>('expressionWidth'),
    linesBetweenQueries: cfg.get<unknown>('linesBetweenQueries'),
  };
  return {
    keywordCase:
      raw.keywordCase === 'upper' || raw.keywordCase === 'lower' || raw.keywordCase === 'preserve'
        ? raw.keywordCase
        : DEFAULTS.keywordCase,
    indentSize: clampInt(raw.indentSize, 1, 8, DEFAULTS.indentSize),
    expressionWidth: clampInt(raw.expressionWidth, 40, 240, DEFAULTS.expressionWidth),
    linesBetweenQueries: clampInt(raw.linesBetweenQueries, 1, 5, DEFAULTS.linesBetweenQueries),
  };
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  const i = Math.trunc(raw);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/**
 * Format a SQL document. Returns the TextEdits VS Code should apply, or
 * `undefined` if VS Code asked us to cancel.
 *
 * `undefined` vs `[]`: VS Code uses both to mean "no changes," but
 * returning `undefined` from a provider after cancellation is the
 * documented contract; returning `[]` means "I succeeded but there's
 * nothing to do" (e.g. already formatted). The behaviour is identical
 * for the user — we keep the distinction so the contract is clean.
 */
export function formatSqlDocument(
  document: vscode.TextDocument,
  token: vscode.CancellationToken,
): vscode.TextEdit[] | undefined {
  if (token.isCancellationRequested) return undefined;
  const original = document.getText();
  if (original.trim() === '') return [];

  const settings = readSettings();
  // sql-formatter throws on certain malformed input; let the caller catch
  // and toast. Don't swallow here — the registerFormatter layer needs to
  // know format failed so it can avoid returning a destructive empty edit.
  const formatted = sqlFormatterFormat(original, {
    language: 'bigquery',
    keywordCase: settings.keywordCase,
    tabWidth: settings.indentSize,
    useTabs: false,
    expressionWidth: settings.expressionWidth,
    linesBetweenQueries: settings.linesBetweenQueries,
  });

  if (token.isCancellationRequested) return undefined;
  if (formatted === original) return [];

  // Replace the entire document content in a single edit so undo collapses
  // to one step. VS Code's TextEdit.replace handles end-of-document ranges
  // correctly via document.lineCount / document.lineAt.
  const lastLine = document.lineAt(document.lineCount - 1);
  const fullRange = new vscode.Range(
    new vscode.Position(0, 0),
    lastLine.range.end,
  );
  return [vscode.TextEdit.replace(fullRange, formatted)];
}
