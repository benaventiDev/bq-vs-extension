import type { ParsedColumn, ParsedRow } from '../bq/parseJson';
import type { Rule } from './rules/rulesStore';

/**
 * M11 timing breakdown for a single Shift+Enter run. `totalMs` is the
 * wall-clock from query start to result-ready (parse included). The other
 * three are the cost of each phase the user can think about: bq's dry-run
 * round-trip, bq's real-query round-trip, and our own JSON parse step.
 * Surfaces in the footer clock-icon tooltip.
 */
export interface TimingInfo {
  totalMs: number;
  dryMs: number;
  realMs: number;
  parseMs: number;
}

/**
 * Per-statement result inside a multi-statement run. Mirrors
 * StatementResult from bq/multiStatement.ts, kept here in the panel layer
 * so the webview doesn't need to import directly from src/bq.
 *
 * `executionMs` on the SELECT/DML/DDL outcomes is the child job's
 * end-time minus start-time (from `bq ls --jobs --parent_job_id`). Null
 * when the M7 enrichment pass failed or didn't fire — the M7 overview
 * silently omits the annotation in that case.
 */
export type StatementOutcome =
  | { kind: 'select'; columns: ParsedColumn[]; rows: ParsedRow[]; executionMs?: number | null }
  | { kind: 'dml'; rowsAffected: number; message: string; executionMs?: number | null }
  | { kind: 'ddl'; message: string; executionMs?: number | null }
  | { kind: 'script-completed'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

/**
 * Multi-statement render path. `sqlPreviews[i]` is the best-effort display
 * text for statement i (may be null when the alignment heuristic gave up).
 * For single-statement runs we keep using `kind: 'ok'` below — no overview
 * table, no chip strip, byte-identical rendering to M6.
 */
export interface MultiStatementResult {
  kind: 'multi';
  statements: StatementOutcome[];
  sqlPreviews: (string | null)[];
  timing?: TimingInfo;
}

export type TabResult =
  | { kind: 'running' }
  | { kind: 'ok'; columns: ParsedColumn[]; rows: ParsedRow[]; timing?: TimingInfo }
  | { kind: 'error'; message: string }
  | MultiStatementResult;

export interface TabState {
  key: string;
  basename: string;
  tooltip: string;
  result: TabResult;
}

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export type NestedRenderMode = 'inline' | 'explode';

/**
 * M10 export message bus. Webview generates the payload (CSV/TSV/JSON
 * strings or Excel binary) and hands it to the host, which runs the save
 * dialog (webviews can't trigger native dialogs) or writes to clipboard.
 * The host echoes the outcome back with the same requestId so the webview
 * can show the right footer status toast.
 */
export type ExportFormat = 'csv' | 'xlsx' | 'json';

export type HostToWebviewMessage =
  | { type: 'tab-update'; tab: TabState }
  | { type: 'tab-drop'; key: string }
  // `key` is the active editor's tab key (null when that file has no result
  // slot). `activeEditorKey` is the live active .sql editor URI regardless of
  // whether a result slot exists — the webview needs it for the pin-mismatch
  // banner ("currently editing <other>.sql") since the pinned result may
  // belong to a different file than the one in focus. Null when no .sql
  // editor is focused.
  | { type: 'set-active'; key: string | null; activeEditorKey: string | null }
  | {
      type: 'theme-changed';
      resolved: ResolvedTheme;
      preference: ThemePreference;
    }
  | { type: 'highlight-mode-changed'; enabled: boolean }
  | { type: 'render-mode-changed'; mode: NestedRenderMode }
  | { type: 'panel-zoom-changed'; zoom: number }
  | { type: 'rules-changed'; uri: string; rules: Rule[] }
  | { type: 'clipboard-text'; requestId: string; text: string }
  | {
      type: 'export-complete';
      requestId: string;
      ok: boolean;
      filename?: string;
      error?: string;
      // Distinguishes file-save completions from clipboard completions for
      // the toast wording. 'cancelled' = user dismissed the save dialog.
      kind: 'save' | 'clipboard' | 'cancelled';
      // For clipboard completions: the row count copied (echoed back so the
      // webview doesn't have to track it across the round-trip).
      rowCount?: number;
    };

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'close-tab'; key: string }
  | { type: 'cancel'; key: string }
  | { type: 'set-theme-preference'; preference: ThemePreference }
  | { type: 'set-highlight-mode'; enabled: boolean }
  | { type: 'set-render-mode'; mode: NestedRenderMode }
  | { type: 'set-panel-zoom'; zoom: number }
  | { type: 'save-rules'; uri: string; rules: Rule[] }
  | { type: 'request-clipboard'; requestId: string }
  | {
      type: 'export-save';
      requestId: string;
      format: ExportFormat;
      defaultFilename: string;
      // String for csv / json; Uint8Array for xlsx. Structured-clone moves
      // both through postMessage cleanly.
      content: string | Uint8Array;
    }
  | {
      type: 'export-clipboard';
      requestId: string;
      text: string;
      rowCount: number;
    }
  // Sheets-style cell-range copy (Ctrl/Cmd+C over a selected block of cells
  // when the color toggle is OFF). Fire-and-forget: the host writes the TSV
  // to the OS clipboard and shows a brief status-bar confirmation. rows/cols
  // describe the copied rectangle for that message; no requestId round-trip
  // since nothing in the webview waits on the result.
  | {
      type: 'copy-cells';
      text: string;
      rows: number;
      cols: number;
    };
