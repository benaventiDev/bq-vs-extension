// Persistence layer for conditional-formatting rules. Rules are stored in
// VS Code's workspaceState keyed by `vscode.Uri.toString()` of the .sql file
// the rules belong to — strictly per file, never shared between files. The
// store is also responsible for these file-lifecycle behaviors:
//
//   - file delete → drop rules
//   - file rename → re-key rules under the new URI
//
// The store does not validate formula syntax — the webview validates on save
// and we accept whatever the host gets handed. The rules are JSON-serialised
// blobs of `{ id, formula, color, createdAt }`.

import * as vscode from 'vscode';
import * as path from 'path';

const STORE_KEY = 'bqVsExtension.formattingRules.v1';

export const RULE_COLORS = [
  'yellow',
  'orange',
  'red',
  'pink',
  'purple',
  'blue',
  'cyan',
  'green',
  'brown',
] as const;
export type RuleColor = (typeof RULE_COLORS)[number];

export interface Rule {
  id: string;             // stable identifier; new ids generated for copies
  formula: string;        // the raw user-typed formula text
  color: RuleColor;
  createdAt: number;      // ms since epoch — used as a stable secondary sort
}

// Persisted shape: { [uriKey]: Rule[] }
type StoredMap = Record<string, Rule[]>;

export interface RulesChangeEvent {
  uri: string;            // file URI key
  rules: Rule[];          // new state for that file (empty array if cleared)
}

export class RulesStore {
  private readonly listeners = new Set<(e: RulesChangeEvent) => void>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  public onDidChange(listener: (e: RulesChangeEvent) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  public get(uri: vscode.Uri | string): Rule[] {
    const key = typeof uri === 'string' ? uri : uri.toString();
    const map = this.readMap();
    const arr = map[key];
    return Array.isArray(arr) ? arr.map(cloneRule) : [];
  }

  public async set(uri: vscode.Uri | string, rules: Rule[]): Promise<void> {
    const key = typeof uri === 'string' ? uri : uri.toString();
    const map = this.readMap();
    if (rules.length === 0) {
      delete map[key];
    } else {
      map[key] = rules.map(cloneRule);
    }
    await this.writeMap(map);
    this.emit({ uri: key, rules: this.get(key) });
  }

  public async clear(uri: vscode.Uri | string): Promise<void> {
    await this.set(uri, []);
  }

  public async deleteForUri(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const map = this.readMap();
    if (!(key in map)) return;
    delete map[key];
    await this.writeMap(map);
    this.emit({ uri: key, rules: [] });
  }

  public async renameUri(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const oldKey = oldUri.toString();
    const newKey = newUri.toString();
    const map = this.readMap();
    const arr = map[oldKey];
    if (!arr) return;
    delete map[oldKey];
    // If the new key already has rules (e.g. rename onto an existing file —
    // unlikely with VS Code's rename UI, but defensible), let the existing
    // rules win and drop the moved ones. This avoids silently overwriting
    // user-owned state.
    if (!(newKey in map)) {
      map[newKey] = arr;
    }
    await this.writeMap(map);
    this.emit({ uri: oldKey, rules: [] });
    this.emit({ uri: newKey, rules: this.get(newKey) });
  }

  private readMap(): StoredMap {
    const raw = this.context.workspaceState.get<unknown>(STORE_KEY);
    if (!raw || typeof raw !== 'object') return {};
    const out: StoredMap = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const arr: Rule[] = [];
      for (const item of v) {
        if (isValidRule(item)) arr.push(item);
      }
      if (arr.length > 0) out[k] = arr;
    }
    return out;
  }

  private async writeMap(map: StoredMap): Promise<void> {
    await this.context.workspaceState.update(STORE_KEY, map);
  }

  private emit(e: RulesChangeEvent): void {
    for (const l of this.listeners) {
      try { l(e); } catch { /* swallow listener errors */ }
    }
  }
}

function isValidRule(v: unknown): v is Rule {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string') return false;
  if (typeof r.formula !== 'string') return false;
  if (typeof r.createdAt !== 'number') return false;
  if (typeof r.color !== 'string') return false;
  return (RULE_COLORS as readonly string[]).includes(r.color);
}

function cloneRule(r: Rule): Rule {
  return { id: r.id, formula: r.formula, color: r.color, createdAt: r.createdAt };
}

// Used by callers (resultViewProvider) to short-circuit when a path isn't a
// .sql file on disk; kept here so the store-related path logic lives in one
// place.
export function isSqlFileUri(uri: vscode.Uri): boolean {
  return (
    uri.scheme === 'file' &&
    path.extname(uri.fsPath).toLowerCase() === '.sql'
  );
}
