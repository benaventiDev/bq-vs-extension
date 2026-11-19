import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { hasSnowflakeConfig } from './snowflake/config';

// Which warehouse a run goes to. Detection only looks at what's already on
// the user's machine (gcloud config, Snowflake connections file); nothing is
// ever installed, created or asked for. Adding a warehouse = add an id here,
// a detector, and a runner in commands/runSelection.ts.

export type EngineId = 'bigquery' | 'snowflake';

export const ENGINES: { id: EngineId; label: string }[] = [
  { id: 'bigquery', label: 'BigQuery' },
  { id: 'snowflake', label: 'Snowflake' },
];

export function engineLabel(id: EngineId): string {
  return ENGINES.find((e) => e.id === id)?.label ?? id;
}

const CONFIG_SECTION = 'bqVsExtension';
const DEFAULT_ENGINE_KEY = 'defaultEngine';

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** gcloud / bq set up: a gcloud config dir or an explicit credentials file. */
export function hasBigQueryConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.GOOGLE_APPLICATION_CREDENTIALS && exists(env.GOOGLE_APPLICATION_CREDENTIALS)) return true;
  const dir =
    env.CLOUDSDK_CONFIG ||
    (process.platform === 'win32'
      ? path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'gcloud')
      : path.join(os.homedir(), '.config', 'gcloud'));
  return exists(path.join(dir, 'configurations')) || exists(path.join(dir, 'application_default_credentials.json'));
}

export function detectEngines(): EngineId[] {
  const found: EngineId[] = [];
  if (hasBigQueryConfig()) found.push('bigquery');
  if (hasSnowflakeConfig()) found.push('snowflake');
  return found;
}

function configuredDefault(): EngineId | undefined {
  const v = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(DEFAULT_ENGINE_KEY, '');
  return v === 'bigquery' || v === 'snowflake' ? v : undefined;
}

async function pickEngine(candidates: EngineId[], title: string): Promise<EngineId | undefined> {
  const items = candidates.map((id) => ({ label: engineLabel(id), id }));
  const picked = await vscode.window.showQuickPick(items, { title, placeHolder: 'Run the query on…' });
  return picked?.id;
}

async function saveDefault(id: EngineId, announce: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(DEFAULT_ENGINE_KEY, id, vscode.ConfigurationTarget.Global);
  if (!announce) return;
  const openSetting = 'Change default';
  const shortcuts = 'Keyboard shortcuts';
  void vscode.window
    .showInformationMessage(
      `${engineLabel(id)} set as default for Shift+Enter — change it anytime with the "SQL: Select Default Warehouse" command. Each warehouse also has its own Run commands you can bind to a different shortcut.`,
      openSetting,
      shortcuts,
    )
    .then((choice) => {
      if (choice === openSetting) {
        void vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.${DEFAULT_ENGINE_KEY}`);
      } else if (choice === shortcuts) {
        void vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'bqVsExtension.run');
      }
    });
}

/**
 * Engine for the generic Run commands (Shift+Enter / Run buttons):
 * the setting if set; else the only detected warehouse, silently; else ask
 * once and remember. Nothing detected → BigQuery, whose own error explains
 * what's missing (the pre-Snowflake behaviour).
 */
export async function resolveDefaultEngine(): Promise<EngineId | undefined> {
  const fromSetting = configuredDefault();
  if (fromSetting) return fromSetting;
  const detected = detectEngines();
  if (detected.length === 0) return 'bigquery';
  if (detected.length === 1) return detected[0];
  const picked = await pickEngine(detected, 'Several warehouses are set up on this machine. Which one should Shift+Enter use?');
  if (picked) await saveDefault(picked, true);
  return picked;
}

/** "Select Default Engine" command. */
export async function chooseDefaultEngineCommand(): Promise<void> {
  const detected = detectEngines();
  const all = ENGINES.map((e) => e.id);
  const ordered = [...detected, ...all.filter((id) => !detected.includes(id))];
  const picked = await pickEngine(ordered, 'Default warehouse for Shift+Enter and the Run buttons');
  if (picked) await saveDefault(picked, true);
}

export function snowflakeConnectionSetting(): string | undefined {
  const v = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('snowflake.connection', '');
  return v.trim() || undefined;
}
