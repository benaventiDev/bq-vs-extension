import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LIVE } from './helpers';
import { realConfigEnv, type ConfigEnv } from '../../src/snowflake/config';
import { executeStatement, getConnection, resolveConnection, dropConnection } from '../../src/snowflake/client';

// Cross-tool check: put the user's real connection in each place the
// official tools look, and confirm the Snowflake CLI, the Python connector,
// the Node driver's own loader and our reader all pick the same file, by
// actually connecting and asking Snowflake which schema the session got
// (each location's copy points at a different TPCH schema).
//
// Windows-only for now (macOS / Linux layouts are covered by the unit tests
// with a faked OS). Needs ~/.snowflake/connections.toml with a working
// connection named "main" (the real file is read, never modified); all the
// copies live in a temp folder that is removed afterwards.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const toml = require('smol-toml') as { parse: (s: string) => any; stringify: (o: unknown) => string };

const WIN = process.platform === 'win32';
const PY = process.env.BQX_SF_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'pipx', 'pipx', 'venvs', 'snowflake-cli', 'Scripts', 'python.exe');
const SNOW = 'snow';
const REAL_CONN = path.join(os.homedir(), '.snowflake', 'connections.toml');

const canRun = LIVE && WIN && fs.existsSync(REAL_CONN) && fs.existsSync(PY);

describe('live: every tool picks the same connection file', { skip: !canRun }, () => {
  let base = '';
  let main: Record<string, unknown> = {};

  /** Write a connections.toml whose connection points at `schema`. */
  function writeConn(dir: string, name: string, schema: string, configDefault?: string): void {
    fs.mkdirSync(dir, { recursive: true });
    const conn = { ...main, database: 'SNOWFLAKE_SAMPLE_DATA', schema };
    fs.writeFileSync(path.join(dir, 'connections.toml'), toml.stringify({ [name]: conn }));
    if (configDefault) fs.writeFileSync(path.join(dir, 'config.toml'), `default_connection_name = "${configDefault}"\n`);
  }

  function childEnv(home: string, snowflakeHome?: string, extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.toUpperCase().startsWith('SNOWFLAKE_')) env[k] = v;
    }
    env.USERPROFILE = home;
    env.HOME = home;
    env.PYTHONUTF8 = '1';
    if (snowflakeHome) env.SNOWFLAKE_HOME = snowflakeHome;
    return { ...env, ...extra };
  }

  function viaPython(env: Record<string, string>): string {
    const code = 'import snowflake.connector as sc\nc = sc.connect()\nprint("SCHEMA=" + str(c.cursor().execute("select current_schema()").fetchone()[0]))';
    const r = spawnSync(PY, ['-c', code], { env, encoding: 'utf8', timeout: 120000 });
    return /SCHEMA=(\S+)/.exec(r.stdout)?.[1] ?? `ERR ${r.stderr.split('\n').filter(Boolean).slice(-1)[0]}`;
  }

  function viaCli(env: Record<string, string>): string {
    const r = spawnSync(SNOW, ['sql', '-q', 'select current_schema() as s', '--format', 'json'], { env, encoding: 'utf8', timeout: 120000 });
    const m = /"S"\s*:\s*"([^"]+)"/.exec(r.stdout);
    return m?.[1] ?? `ERR ${(r.stderr || r.stdout).split('\n').filter(Boolean).slice(-1)[0]}`;
  }

  /** The Node driver's built-in loader (only knows SNOWFLAKE_HOME / ~/.snowflake). */
  function viaNodeSdkLoader(env: Record<string, string>): string {
    const code = `require('snowflake-sdk').configure({ logLevel: 'OFF' }); try { const c = require('snowflake-sdk/dist/lib/configuration/connection_configuration').loadConnectionConfiguration(); console.log('SCHEMA=' + c.schema); } catch (e) { console.log('ERR ' + e.message); }`;
    const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8', cwd: path.join(__dirname, '..', '..') });
    return /SCHEMA=(\S+)/.exec(r.stdout)?.[1] ?? r.stdout.trim().split('\n').slice(-1)[0];
  }

  async function viaExtension(env: Record<string, string>, home: string): Promise<string> {
    const ce: ConfigEnv = { ...realConfigEnv(), env, homedir: home };
    const resolved = resolveConnection(undefined, ce);
    if ('error' in resolved) return `ERR ${resolved.error}`;
    const conn = await getConnection(resolved);
    const r = await executeStatement(conn, 'select current_schema() as s').promise;
    dropConnection(resolved.name);
    return r.ok ? String(r.rows[0][0]) : `ERR ${r.error}`;
  }

  before(() => {
    main = toml.parse(fs.readFileSync(REAL_CONN, 'utf8')).main;
    assert.ok(main && main.account, 'expected a "main" connection in ~/.snowflake/connections.toml');
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'bqx-loc-'));
  });

  after(() => {
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it('$SNOWFLAKE_HOME beats ~/.snowflake', async () => {
    const home = path.join(base, 'h1');
    writeConn(path.join(home, '.snowflake'), 'dot', 'TPCH_SF10', 'dot');
    const sfHome = path.join(base, 'sfhome');
    writeConn(sfHome, 'custom', 'TPCH_SF1', 'custom');
    const env = childEnv(home, sfHome);
    const got = { cli: viaCli(env), python: viaPython(env), nodeSdk: viaNodeSdkLoader(env), extension: await viaExtension(env, home) };
    assert.deepEqual(got, { cli: 'TPCH_SF1', python: 'TPCH_SF1', nodeSdk: 'ERR Connection configuration with name default does not exist', extension: 'TPCH_SF1' });
  });

  it('~/.snowflake when SNOWFLAKE_HOME is unset', async () => {
    const home = path.join(base, 'h2');
    writeConn(path.join(home, '.snowflake'), 'default', 'TPCH_SF100');
    const env = childEnv(home);
    const got = { cli: viaCli(env), python: viaPython(env), nodeSdk: viaNodeSdkLoader(env), extension: await viaExtension(env, home) };
    assert.deepEqual(got, { cli: 'TPCH_SF100', python: 'TPCH_SF100', nodeSdk: 'TPCH_SF100', extension: 'TPCH_SF100' });
  });

  // The CLI and the Python connector both resolve the Windows app-data dir
  // under the (here faked) user profile; we read %LOCALAPPDATA%, which is the
  // same folder on a real machine, so the fake layout sets both.
  it('the OS config directory (%LOCALAPPDATA%\\snowflake) when there is no ~/.snowflake', async () => {
    const home = path.join(base, 'h3');
    const local = path.join(home, 'AppData', 'Local');
    writeConn(path.join(local, 'snowflake'), 'default', 'TPCH_SF1000');
    // A SNOWFLAKE_HOME pointing at a missing directory must be ignored.
    const env = childEnv(home, path.join(base, 'missing'), { LOCALAPPDATA: local });
    const got = { cli: viaCli(env), python: viaPython(env), nodeSdk: viaNodeSdkLoader(env), extension: await viaExtension(env, home) };
    assert.equal(got.cli, 'TPCH_SF1000');
    assert.equal(got.python, 'TPCH_SF1000');
    assert.equal(got.extension, 'TPCH_SF1000');
    // The Node driver's loader doesn't know this location — why we have our own.
    assert.match(got.nodeSdk, /^ERR/);
  });

  it('default connection: SNOWFLAKE_DEFAULT_CONNECTION_NAME beats config.toml', async () => {
    const home = path.join(base, 'h4');
    const dir = path.join(home, '.snowflake');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'connections.toml'), toml.stringify({
      a: { ...main, database: 'SNOWFLAKE_SAMPLE_DATA', schema: 'TPCH_SF1' },
      b: { ...main, database: 'SNOWFLAKE_SAMPLE_DATA', schema: 'TPCH_SF10' },
    }));
    fs.writeFileSync(path.join(dir, 'config.toml'), 'default_connection_name = "a"\n');
    const fromConfig = childEnv(home);
    assert.equal(viaCli(fromConfig), 'TPCH_SF1');
    assert.equal(viaPython(fromConfig), 'TPCH_SF1');
    assert.equal(await viaExtension(fromConfig, home), 'TPCH_SF1');
    const fromEnv = childEnv(home, undefined, { SNOWFLAKE_DEFAULT_CONNECTION_NAME: 'b' });
    assert.equal(viaCli(fromEnv), 'TPCH_SF10');
    assert.equal(viaPython(fromEnv), 'TPCH_SF10');
    assert.equal(viaNodeSdkLoader(fromEnv), 'TPCH_SF10');
    assert.equal(await viaExtension(fromEnv, home), 'TPCH_SF10');
  });

  it('per-key env override SNOWFLAKE_CONNECTIONS_<NAME>_<KEY>', async () => {
    const home = path.join(base, 'h5');
    writeConn(path.join(home, '.snowflake'), 'default', 'TPCH_SF1');
    const env = childEnv(home, undefined, { SNOWFLAKE_CONNECTIONS_DEFAULT_SCHEMA: 'TPCH_SF10' });
    assert.equal(viaCli(env), 'TPCH_SF10');
    assert.equal(await viaExtension(env, home), 'TPCH_SF10');
  });
});
