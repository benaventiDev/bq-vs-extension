import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// smol-toml ships a CJS build, but its typings are ESM-only, which tsc's
// Node16 mode refuses to `import` from a CJS file; require it directly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parse: parseToml } = require('smol-toml') as { parse: (text: string) => unknown };

// Reads the user's existing Snowflake connection setup — the same
// `connections.toml` / `config.toml` the Snowflake CLI, the Python connector
// and the other official drivers share. We never create or change these
// files and never ask for credentials: whatever login method the user chose
// (password, SSO, key pair, OAuth, MFA, PAT, ...) is a field in the file and
// is handed to the driver as-is.
//
// Location + precedence rules mirror the Python connector / Snowflake CLI
// (snowflake.connector.sf_dirs + config_manager), which is the reference
// implementation the rest of the ecosystem follows:
//   1. $SNOWFLAKE_HOME, if that directory exists
//   2. ~/.snowflake, if that directory exists
//   3. the OS config dir: %LOCALAPPDATA%\snowflake (Windows),
//      ~/Library/Application Support/snowflake (macOS),
//      $XDG_CONFIG_HOME/snowflake or ~/.config/snowflake (Linux)
// If `connections.toml` exists there it supplies ALL connections and the
// `[connections.*]` tables in `config.toml` are ignored (same as the CLI).
//
// Deliberately NOT copied from the Node driver's own loader: it only looks
// in $SNOWFLAKE_HOME / ~/.snowflake, ignores `default_connection_name`, and
// refuses files readable by other users (common on macOS) where the official
// tools only warn.

/** Injected for tests so every OS layout can be exercised from any machine. */
export interface ConfigEnv {
  platform: NodeJS.Platform;
  homedir: string;
  env: Record<string, string | undefined>;
  exists: (p: string) => boolean;
  readFile: (p: string) => string;
}

export function realConfigEnv(): ConfigEnv {
  return {
    platform: process.platform,
    homedir: os.homedir(),
    env: process.env,
    exists: (p) => {
      try {
        fs.statSync(p);
        return true;
      } catch {
        return false;
      }
    },
    readFile: (p) => fs.readFileSync(p, 'utf8'),
  };
}

export type ConnectionParams = Record<string, unknown>;

export interface SnowflakeConfig {
  /** Directory the files were looked up in (whether or not they exist). */
  configDir: string;
  /** Files that were actually read, in read order. */
  filesRead: string[];
  connections: Record<string, ConnectionParams>;
  /** Name from env / config.toml (may not exist in `connections`). */
  defaultConnectionName: string | undefined;
  /** Problems worth surfacing (unparseable file, ...). Never fatal on their own. */
  warnings: string[];
}

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function expandHome(p: string, ce: Pick<ConfigEnv, 'platform' | 'homedir'>): string {
  if (p === '~') return ce.homedir;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return pathFor(ce.platform).join(ce.homedir, p.slice(2));
  }
  return p;
}

/** The directory the official tools would read Snowflake config from. */
export function resolveConfigDir(ce: ConfigEnv): string {
  const p = pathFor(ce.platform);
  const home = ce.env.SNOWFLAKE_HOME;
  if (home && ce.exists(expandHome(home, ce))) return expandHome(home, ce);
  const dotDir = p.join(ce.homedir, '.snowflake');
  if (ce.exists(dotDir)) return dotDir;
  switch (ce.platform) {
    case 'win32':
      return p.join(ce.env.LOCALAPPDATA || p.join(ce.homedir, 'AppData', 'Local'), 'snowflake');
    case 'darwin':
      return p.join(ce.homedir, 'Library', 'Application Support', 'snowflake');
    default:
      return p.join(ce.env.XDG_CONFIG_HOME || p.join(ce.homedir, '.config'), 'snowflake');
  }
}

function isTable(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function tablesOnly(obj: Record<string, unknown>): Record<string, ConnectionParams> {
  const out: Record<string, ConnectionParams> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isTable(v)) out[k] = { ...v };
  }
  return out;
}

function tryParse(file: string, text: string, warnings: string[]): Record<string, unknown> | null {
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    warnings.push(`Could not parse ${file}: ${msg}`);
    return null;
  }
}

/**
 * Env overrides the CLI understands: SNOWFLAKE_CONNECTIONS_<NAME>_<KEY>=value
 * sets <key> on connection <name>. Names may contain underscores, so match
 * against the known connection names, longest first.
 */
function applyEnvOverrides(
  connections: Record<string, ConnectionParams>,
  env: Record<string, string | undefined>,
): void {
  const names = Object.keys(connections).sort((a, b) => b.length - a.length);
  for (const [envKey, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = envKey.toUpperCase();
    if (!upper.startsWith('SNOWFLAKE_CONNECTIONS_')) continue;
    const rest = upper.slice('SNOWFLAKE_CONNECTIONS_'.length);
    const name = names.find((n) => rest.startsWith(`${n.toUpperCase()}_`));
    if (!name) continue;
    const key = rest.slice(name.length + 1).toLowerCase();
    if (key) connections[name][key] = value;
  }
}

export function loadSnowflakeConfig(ce: ConfigEnv = realConfigEnv()): SnowflakeConfig {
  const p = pathFor(ce.platform);
  const configDir = resolveConfigDir(ce);
  const filesRead: string[] = [];
  const warnings: string[] = [];

  let configToml: Record<string, unknown> = {};
  const configPath = p.join(configDir, 'config.toml');
  if (ce.exists(configPath)) {
    filesRead.push(configPath);
    configToml = tryParse(configPath, ce.readFile(configPath), warnings) ?? {};
  }

  let connections: Record<string, ConnectionParams> = {};
  let lenientDefault: string | undefined;
  const connPath = p.join(configDir, 'connections.toml');
  if (ce.exists(connPath)) {
    filesRead.push(connPath);
    const parsed = tryParse(connPath, ce.readFile(connPath), warnings) ?? {};
    // Some setups nest everything under [connections.*] in this file too.
    const root = isTable(parsed.connections) ? parsed.connections : parsed;
    connections = tablesOnly(root);
    // Not honoured by the official tools (they read it from config.toml
    // only) but people do write it here; accept it as a last resort.
    if (typeof parsed.default_connection_name === 'string') {
      lenientDefault = parsed.default_connection_name;
    }
  } else if (isTable(configToml.connections)) {
    connections = tablesOnly(configToml.connections);
  }

  // SNOWFLAKE_CONNECTIONS may hold a whole TOML document of connections.
  const envConnections = ce.env.SNOWFLAKE_CONNECTIONS;
  if (envConnections && envConnections.trim()) {
    const parsed = tryParse('SNOWFLAKE_CONNECTIONS', envConnections, warnings);
    if (parsed) connections = tablesOnly(isTable(parsed.connections) ? parsed.connections : parsed);
  }

  applyEnvOverrides(connections, ce.env);

  const fromConfig =
    typeof configToml.default_connection_name === 'string'
      ? configToml.default_connection_name
      : undefined;
  const defaultConnectionName =
    ce.env.SNOWFLAKE_DEFAULT_CONNECTION_NAME || fromConfig || lenientDefault;

  return { configDir, filesRead, connections, defaultConnectionName, warnings };
}

/**
 * Which connection to use. `preferred` is the extension setting (empty =
 * follow the user's Snowflake config). Order: setting → env / config.toml
 * default → a connection literally named "default" → the only connection.
 */
export function pickConnectionName(
  cfg: SnowflakeConfig,
  preferred?: string,
): { name: string } | { error: string } {
  const names = Object.keys(cfg.connections);
  if (preferred) {
    return cfg.connections[preferred]
      ? { name: preferred }
      : { error: `Snowflake connection "${preferred}" (from the extension setting) was not found in ${cfg.configDir}. Available: ${names.join(', ') || 'none'}.` };
  }
  if (cfg.defaultConnectionName) {
    return cfg.connections[cfg.defaultConnectionName]
      ? { name: cfg.defaultConnectionName }
      : { error: `Default Snowflake connection "${cfg.defaultConnectionName}" was not found in ${cfg.configDir}. Available: ${names.join(', ') || 'none'}.` };
  }
  if (cfg.connections.default) return { name: 'default' };
  if (names.length === 1) return { name: names[0] };
  if (names.length === 0) {
    return { error: `No Snowflake connections found. Looked in ${cfg.configDir} (connections.toml / config.toml).` };
  }
  return {
    error: `Several Snowflake connections found (${names.join(', ')}) and none is marked as default. Set default_connection_name in config.toml or the "bqVsExtension.snowflake.connection" setting.`,
  };
}

// --- Mapping to snowflake-sdk ConnectionOptions -----------------------------

const KEY_ALIASES: Record<string, string> = {
  user: 'username',
  private_key_file: 'privateKeyPath',
  private_key_path: 'privateKeyPath',
  private_key_file_pwd: 'privateKeyPass',
  private_key_pwd: 'privateKeyPass',
  private_key_passphrase: 'privateKeyPass',
  client_request_mfa_token: 'clientRequestMFAToken',
  disable_saml_url_check: 'disableSamlURLCheck',
  // Python-only knobs with no Node equivalent are dropped below.
};

const PATH_KEYS = new Set(['privateKeyPath', 'tokenFilePath']);
const DROPPED_KEYS = new Set(['login_timeout', 'network_timeout', 'socket_timeout', 'ocsp_fail_open']);

function snakeToCamel(k: string): string {
  return k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Turn a TOML connection table into snowflake-sdk options. `readFile` is used
 * for `token_file_path` (OAuth / PAT tokens kept in a file).
 */
export function toSdkOptions(
  params: ConnectionParams,
  ce: Pick<ConfigEnv, 'platform' | 'homedir' | 'readFile'> = realConfigEnv(),
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    const key = rawKey.toLowerCase();
    if (DROPPED_KEYS.has(key)) continue;
    const target = KEY_ALIASES[key] ?? snakeToCamel(key);
    if (out[target] !== undefined) continue;
    out[target] =
      PATH_KEYS.has(target) && typeof value === 'string'
        ? expandHome(value, ce)
        : value;
  }

  // Numeric fields sometimes arrive as strings (env overrides).
  if (typeof out.port === 'string' && /^\d+$/.test(out.port)) out.port = Number(out.port);

  if (typeof out.tokenFilePath === 'string' && out.token === undefined) {
    out.token = ce.readFile(out.tokenFilePath).trim();
  }
  delete out.tokenFilePath;

  const auth = typeof out.authenticator === 'string' ? out.authenticator : '';
  // Python connector / CLI pick key-pair auth automatically when a private
  // key is configured without an explicit authenticator.
  if (!auth && (out.privateKey || out.privateKeyPath)) {
    out.authenticator = 'SNOWFLAKE_JWT';
  } else if (auth && !/^https?:\/\//i.test(auth)) {
    out.authenticator = auth.toUpperCase();
  }

  // The official connectors cache SSO / MFA tokens on macOS + Windows by
  // default so users aren't re-prompted on every start; the Node driver
  // doesn't, so opt in unless the user said otherwise.
  const a = String(out.authenticator ?? '');
  if (
    out.clientStoreTemporaryCredential === undefined &&
    (a === 'EXTERNALBROWSER' || a === 'OAUTH_AUTHORIZATION_CODE') &&
    ce.platform !== 'linux'
  ) {
    out.clientStoreTemporaryCredential = true;
  }
  if (out.clientRequestMFAToken === undefined && a === 'USERNAME_PASSWORD_MFA') {
    out.clientRequestMFAToken = true;
  }

  return out;
}

/** True when the user has at least one Snowflake connection configured. */
export function hasSnowflakeConfig(ce: ConfigEnv = realConfigEnv()): boolean {
  try {
    return Object.keys(loadSnowflakeConfig(ce).connections).length > 0;
  } catch {
    return false;
  }
}
