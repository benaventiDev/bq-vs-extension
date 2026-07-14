import * as vscode from 'vscode';

/** GitHub Sponsors page for the extension author. */
export const SPONSOR_URL = 'https://github.com/sponsors/benaventiDev';

const KEY_QUERY_COUNT = 'bqVsExtension.sponsor.queryCount';
const KEY_LAST_NUDGE_AT = 'bqVsExtension.sponsor.lastNudgeAt';

// Gentle cadence: the first nudge only appears after this many *successful*
// queries (realistically several sessions of genuine use), and then no more
// often than once every N days, at most once per session. There is deliberately
// NO auto-stop after repeated dismissals — the ONLY permanent opt-out is the
// `bqVsExtension.showSponsorNudge` setting. That setting is intentionally not a
// toast button, so closing the toast is one easy click while silencing it
// forever takes a deliberate trip to Settings.
const FIRST_NUDGE_AFTER_QUERIES = 50;
const MIN_DAYS_BETWEEN_NUDGES = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

// Resets every extension-host start, so the nudge can fire at most once per
// VS Code session.
let shownThisSession = false;

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('bqVsExtension');
}

function isNudgeEnabled(): boolean {
  return config().get<boolean>('showSponsorNudge', true);
}

function isPreviewEveryRun(): boolean {
  return config().get<boolean>('sponsor.previewEveryRun', false);
}

/** Open the GitHub Sponsors page in the user's browser. */
export function openSponsorPage(): void {
  void vscode.env.openExternal(vscode.Uri.parse(SPONSOR_URL));
}

/**
 * Show the sponsor toast unconditionally. Used by the "Preview Sponsor Message"
 * command and the `sponsor.previewEveryRun` setting. Non-blocking: the toast's
 * X (or "Maybe later") simply dismisses it; only "Sponsor" opens the page.
 */
export async function showSponsorNudgeNow(): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    '❤️ Enjoying BigQuery Explorer? A sponsorship helps keep it free and maintained. Thank you!',
    'Sponsor',
    'Maybe later',
  );
  if (choice === 'Sponsor') {
    openSponsorPage();
  }
}

/**
 * Called after a query finishes. Only successful runs (`ok` / `multi`) count
 * toward the threshold; failures and cancellations are ignored. Applies the
 * gentle cadence above before showing the toast.
 */
export async function maybeShowSponsorNudge(
  context: vscode.ExtensionContext,
  success: boolean,
): Promise<void> {
  // Preview mode for the author: fire on every successful run.
  if (success && isPreviewEveryRun()) {
    await showSponsorNudgeNow();
    return;
  }

  if (!success) return;

  const state = context.globalState;
  const count = state.get<number>(KEY_QUERY_COUNT, 0) + 1;
  await state.update(KEY_QUERY_COUNT, count);

  if (!isNudgeEnabled()) return;
  if (shownThisSession) return;
  if (count < FIRST_NUDGE_AFTER_QUERIES) return;

  const now = Date.now();
  const lastNudgeAt = state.get<number>(KEY_LAST_NUDGE_AT, 0);
  if (lastNudgeAt && now - lastNudgeAt < MIN_DAYS_BETWEEN_NUDGES * DAY_MS) return;

  shownThisSession = true;
  await state.update(KEY_LAST_NUDGE_AT, now);
  await showSponsorNudgeNow();
}
