import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as snowflake from 'snowflake-sdk';
import {
  hasSnowflakeConfig,
  loadSnowflakeConfig,
  pickConnectionName,
  resolveConfigDir,
  toSdkOptions,
  type ConfigEnv,
} from '../../src/snowflake/config';

/** Fake filesystem + env for one OS layout. Directories are implied by files. */
function fakeEnv(
  platform: NodeJS.Platform,
  homedir: string,
  files: Record<string, string>,
  env: Record<string, string> = {},
  extraDirs: string[] = [],
): ConfigEnv {
  const sep = platform === 'win32' ? '\\' : '/';
  const dirs = new Set<string>(extraDirs);
  for (const f of Object.keys(files)) {
    const parts = f.split(sep);
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join(sep));
  }
  return {
    platform,
    homedir,
    env,
    exists: (p) => p in files || dirs.has(p),
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
  };
}

const CONN = `[main]\naccount = "acc-1"\nuser = "me"\npassword = "pw"\n`;

describe('config: where the files are looked up', () => {
  it('Windows: %LOCALAPPDATA%\\snowflake when ~/.snowflake is absent', () => {
    const ce = fakeEnv('win32', 'C:\\Users\\u', { 'C:\\Users\\u\\AppData\\Local\\snowflake\\connections.toml': CONN }, { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
    assert.equal(resolveConfigDir(ce), 'C:\\Users\\u\\AppData\\Local\\snowflake');
    assert.deepEqual(Object.keys(loadSnowflakeConfig(ce).connections), ['main']);
  });

  it('Windows without LOCALAPPDATA falls back to ~/AppData/Local', () => {
    const ce = fakeEnv('win32', 'C:\\Users\\u', {});
    assert.equal(resolveConfigDir(ce), 'C:\\Users\\u\\AppData\\Local\\snowflake');
  });

  it('macOS: ~/Library/Application Support/snowflake', () => {
    const ce = fakeEnv('darwin', '/Users/u', { '/Users/u/Library/Application Support/snowflake/connections.toml': CONN });
    assert.equal(resolveConfigDir(ce), '/Users/u/Library/Application Support/snowflake');
    assert.equal(hasSnowflakeConfig(ce), true);
  });

  it('Linux: $XDG_CONFIG_HOME/snowflake, else ~/.config/snowflake', () => {
    const xdg = fakeEnv('linux', '/home/u', { '/xdg/snowflake/connections.toml': CONN }, { XDG_CONFIG_HOME: '/xdg' });
    assert.equal(resolveConfigDir(xdg), '/xdg/snowflake');
    const plain = fakeEnv('linux', '/home/u', { '/home/u/.config/snowflake/connections.toml': CONN });
    assert.equal(resolveConfigDir(plain), '/home/u/.config/snowflake');
    assert.equal(hasSnowflakeConfig(plain), true);
  });

  for (const [platform, home] of [['win32', 'C:\\Users\\u'], ['darwin', '/Users/u'], ['linux', '/home/u']] as const) {
    const sep = platform === 'win32' ? '\\' : '/';
    it(`${platform}: ~/.snowflake wins over the OS directory when it exists`, () => {
      const dot = `${home}${sep}.snowflake`;
      const ce = fakeEnv(platform, home, { [`${dot}${sep}connections.toml`]: CONN });
      assert.equal(resolveConfigDir(ce), dot);
    });

    it(`${platform}: $SNOWFLAKE_HOME wins when that directory exists`, () => {
      const custom = platform === 'win32' ? 'D:\\sf' : '/opt/sf';
      const ce = fakeEnv(platform, home, { [`${custom}${sep}connections.toml`]: CONN, [`${home}${sep}.snowflake${sep}connections.toml`]: '[other]\naccount="x"' }, { SNOWFLAKE_HOME: custom });
      assert.equal(resolveConfigDir(ce), custom);
      assert.deepEqual(Object.keys(loadSnowflakeConfig(ce).connections), ['main']);
    });

    it(`${platform}: $SNOWFLAKE_HOME pointing nowhere is ignored`, () => {
      const ce = fakeEnv(platform, home, { [`${home}${sep}.snowflake${sep}connections.toml`]: CONN }, { SNOWFLAKE_HOME: platform === 'win32' ? 'D:\\missing' : '/missing' });
      assert.equal(resolveConfigDir(ce), `${home}${sep}.snowflake`);
    });
  }

  it('$SNOWFLAKE_HOME with ~ is expanded', () => {
    const ce = fakeEnv('linux', '/home/u', { '/home/u/sfhome/connections.toml': CONN }, { SNOWFLAKE_HOME: '~/sfhome' });
    assert.equal(resolveConfigDir(ce), '/home/u/sfhome');
  });

  it('no files anywhere → no connections, not an exception', () => {
    const ce = fakeEnv('linux', '/home/u', {});
    assert.equal(hasSnowflakeConfig(ce), false);
    const picked = pickConnectionName(loadSnowflakeConfig(ce));
    assert.ok('error' in picked && /No Snowflake connections found/.test(picked.error));
  });
});

describe('config: which connections and which default', () => {
  const D = '/home/u/.snowflake';
  const env = (files: Record<string, string>, vars: Record<string, string> = {}) =>
    fakeEnv('linux', '/home/u', Object.fromEntries(Object.entries(files).map(([k, v]) => [`${D}/${k}`, v])), vars);

  it('connections.toml replaces the [connections] in config.toml (CLI rule)', () => {
    const cfg = loadSnowflakeConfig(env({
      'connections.toml': CONN,
      'config.toml': 'default_connection_name = "main"\n[connections.legacy]\naccount = "old"\n',
    }));
    assert.deepEqual(Object.keys(cfg.connections), ['main']);
    assert.equal(cfg.defaultConnectionName, 'main');
  });

  it('config.toml [connections.*] is used when there is no connections.toml', () => {
    const cfg = loadSnowflakeConfig(env({ 'config.toml': '[connections.dev]\naccount = "a"\n[connections.prod]\naccount = "b"\n' }));
    assert.deepEqual(Object.keys(cfg.connections).sort(), ['dev', 'prod']);
  });

  it('connections.toml may also nest under [connections.*]', () => {
    const cfg = loadSnowflakeConfig(env({ 'connections.toml': '[connections.x]\naccount = "a"\n' }));
    assert.deepEqual(Object.keys(cfg.connections), ['x']);
  });

  it('default: env var > config.toml > (lenient) connections.toml key', () => {
    const files = {
      'connections.toml': 'default_connection_name = "c"\n[a]\naccount="1"\n[b]\naccount="2"\n[c]\naccount="3"\n',
      'config.toml': 'default_connection_name = "b"\n',
    };
    assert.equal(loadSnowflakeConfig(env(files, { SNOWFLAKE_DEFAULT_CONNECTION_NAME: 'a' })).defaultConnectionName, 'a');
    assert.equal(loadSnowflakeConfig(env(files)).defaultConnectionName, 'b');
    assert.equal(loadSnowflakeConfig(env({ 'connections.toml': files['connections.toml'] })).defaultConnectionName, 'c');
  });

  it('the string key default_connection_name is not mistaken for a connection', () => {
    const cfg = loadSnowflakeConfig(env({ 'connections.toml': 'default_connection_name = "main"\n' + CONN }));
    assert.deepEqual(Object.keys(cfg.connections), ['main']);
  });

  it('pick order: setting → default name → "default" → only connection', () => {
    const two = loadSnowflakeConfig(env({ 'connections.toml': '[default]\naccount="d"\n[x]\naccount="x"\n' }));
    assert.deepEqual(pickConnectionName(two, 'x'), { name: 'x' });
    assert.deepEqual(pickConnectionName(two), { name: 'default' });
    const one = loadSnowflakeConfig(env({ 'connections.toml': '[solo]\naccount="s"\n' }));
    assert.deepEqual(pickConnectionName(one), { name: 'solo' });
  });

  it('several connections and no default → explains how to choose', () => {
    const cfg = loadSnowflakeConfig(env({ 'connections.toml': '[a]\naccount="1"\n[b]\naccount="2"\n' }));
    const r = pickConnectionName(cfg);
    assert.ok('error' in r && /a, b/.test(r.error) && /default_connection_name/.test(r.error));
  });

  it('a default or setting naming a missing connection is reported', () => {
    const cfg = loadSnowflakeConfig(env({ 'connections.toml': CONN, 'config.toml': 'default_connection_name = "gone"\n' }));
    const r = pickConnectionName(cfg);
    assert.ok('error' in r && /"gone"/.test(r.error) && /Available: main/.test(r.error));
    const s = pickConnectionName(cfg, 'nope');
    assert.ok('error' in s && /"nope"/.test(s.error));
  });

  it('SNOWFLAKE_CONNECTIONS_<NAME>_<KEY> overrides a value (names with underscores too)', () => {
    const cfg = loadSnowflakeConfig(env(
      { 'connections.toml': '[my_conn]\naccount="a"\nwarehouse="small"\n[my]\naccount="b"\n' },
      { SNOWFLAKE_CONNECTIONS_MY_CONN_WAREHOUSE: 'big', SNOWFLAKE_CONNECTIONS_MY_ROLE: 'analyst' },
    ));
    assert.equal(cfg.connections.my_conn.warehouse, 'big');
    assert.equal(cfg.connections.my.role, 'analyst');
    assert.equal(cfg.connections.my_conn.role, undefined);
  });

  it('SNOWFLAKE_CONNECTIONS holding a TOML document replaces the files', () => {
    const cfg = loadSnowflakeConfig(env({ 'connections.toml': CONN }, { SNOWFLAKE_CONNECTIONS: '[ci]\naccount = "ci-acc"\n' }));
    assert.deepEqual(Object.keys(cfg.connections), ['ci']);
  });

  it('a broken TOML file is a warning, not a crash', () => {
    const cfg = loadSnowflakeConfig(env({ 'connections.toml': '[main\naccount = ' }));
    assert.deepEqual(cfg.connections, {});
    assert.equal(cfg.warnings.length, 1);
    assert.match(cfg.warnings[0], /Could not parse .*connections\.toml/);
  });

  it('TOML 1.0 features: dotted keys, inline tables, literal strings, comments', () => {
    const cfg = loadSnowflakeConfig(env({
      'connections.toml': `# comment\nmain.account = 'lit\\eral'\nmain.user = "u" # trailing\nother = { account = "inline", port = 443 }\n`,
    }));
    assert.equal(cfg.connections.main.account, 'lit\\eral');
    assert.equal(cfg.connections.other.port, 443);
  });

  it('a Windows file with CRLF line endings and a UTF-8 BOM parses', () => {
    const cfg = loadSnowflakeConfig(fakeEnv('win32', 'C:\\Users\\u', {
      'C:\\Users\\u\\.snowflake\\connections.toml': '\uFEFF[main]\r\naccount = "acc"\r\n',
    }));
    assert.equal(cfg.connections.main?.account, 'acc');
  });
});

describe('config: every login method reaches the driver correctly', () => {
  const ce = { platform: 'win32' as NodeJS.Platform, homedir: 'C:\\Users\\u', readFile: (p: string) => (p.endsWith('token.txt') ? ' tok-123 \n' : '') };
  const linux = { ...ce, platform: 'linux' as NodeJS.Platform, homedir: '/home/u' };

  it('password', () => {
    const o = toSdkOptions({ account: 'a', user: 'u', password: 'p', warehouse: 'wh', role: 'r', database: 'db', schema: 's' }, ce);
    assert.deepEqual(o, { account: 'a', username: 'u', password: 'p', warehouse: 'wh', role: 'r', database: 'db', schema: 's' });
  });

  it('SSO (externalbrowser): upper-cased, token cache on for Windows/macOS only', () => {
    assert.deepEqual(toSdkOptions({ account: 'a', user: 'u', authenticator: 'externalbrowser' }, ce), {
      account: 'a', username: 'u', authenticator: 'EXTERNALBROWSER', clientStoreTemporaryCredential: true,
    });
    assert.equal(toSdkOptions({ account: 'a', authenticator: 'externalbrowser' }, linux).clientStoreTemporaryCredential, undefined);
    assert.equal(toSdkOptions({ account: 'a', authenticator: 'externalbrowser', client_store_temporary_credential: false }, ce).clientStoreTemporaryCredential, false);
  });

  it('Okta native SSO: the URL authenticator is kept verbatim', () => {
    assert.equal(toSdkOptions({ account: 'a', authenticator: 'https://acme.okta.com' }, ce).authenticator, 'https://acme.okta.com');
  });

  it('key pair: file path (with ~), passphrase, authenticator inferred', () => {
    const o = toSdkOptions({ account: 'a', user: 'u', private_key_file: '~/.ssh/rsa_key.p8', private_key_file_pwd: 'secret' }, linux);
    assert.deepEqual(o, { account: 'a', username: 'u', privateKeyPath: '/home/u/.ssh/rsa_key.p8', privateKeyPass: 'secret', authenticator: 'SNOWFLAKE_JWT' });
    const alias = toSdkOptions({ account: 'a', private_key_path: 'k.p8', authenticator: 'snowflake_jwt' }, ce);
    assert.equal(alias.privateKeyPath, 'k.p8');
    assert.equal(alias.authenticator, 'SNOWFLAKE_JWT');
    const inline = toSdkOptions({ account: 'a', private_key: '-----BEGIN PRIVATE KEY-----\n...' }, ce);
    assert.equal(inline.authenticator, 'SNOWFLAKE_JWT');
    assert.ok(String(inline.privateKey).startsWith('-----BEGIN'));
  });

  it('OAuth token inline or from token_file_path', () => {
    assert.deepEqual(toSdkOptions({ account: 'a', authenticator: 'oauth', token: 't' }, ce), { account: 'a', authenticator: 'OAUTH', token: 't' });
    assert.deepEqual(toSdkOptions({ account: 'a', authenticator: 'oauth', token_file_path: 'C:\\t\\token.txt' }, ce), { account: 'a', authenticator: 'OAUTH', token: 'tok-123' });
  });

  it('OAuth authorization code / client credentials keep their client settings', () => {
    const o = toSdkOptions({ account: 'a', authenticator: 'oauth_authorization_code', oauth_client_id: 'id', oauth_client_secret: 's', oauth_redirect_uri: 'http://127.0.0.1:8001' }, ce);
    assert.equal(o.authenticator, 'OAUTH_AUTHORIZATION_CODE');
    assert.equal(o.oauthClientId, 'id');
    assert.equal(o.oauthClientSecret, 's');
    assert.equal(o.oauthRedirectUri, 'http://127.0.0.1:8001');
    assert.equal(o.clientStoreTemporaryCredential, true);
    assert.equal(toSdkOptions({ account: 'a', authenticator: 'oauth_client_credentials', oauth_client_id: 'id' }, ce).authenticator, 'OAUTH_CLIENT_CREDENTIALS');
  });

  it('programmatic access token (PAT)', () => {
    assert.deepEqual(toSdkOptions({ account: 'a', user: 'u', authenticator: 'programmatic_access_token', token: 'pat' }, ce), {
      account: 'a', username: 'u', authenticator: 'PROGRAMMATIC_ACCESS_TOKEN', token: 'pat',
    });
  });

  it('MFA (Duo push / passcode): token caching on, passcode kept', () => {
    const o = toSdkOptions({ account: 'a', user: 'u', password: 'p', authenticator: 'username_password_mfa', passcode: '123456' }, ce);
    assert.equal(o.authenticator, 'USERNAME_PASSWORD_MFA');
    assert.equal(o.clientRequestMFAToken, true);
    assert.equal(o.passcode, '123456');
    assert.equal(toSdkOptions({ account: 'a', authenticator: 'username_password_mfa', passcode_in_password: true }, ce).passcodeInPassword, true);
  });

  it('workload identity federation', () => {
    const o = toSdkOptions({ account: 'a', authenticator: 'workload_identity', workload_identity_provider: 'AWS' }, ce);
    assert.equal(o.authenticator, 'WORKLOAD_IDENTITY');
    assert.equal(o.workloadIdentityProvider, 'AWS');
  });

  it('host / port / protocol, string ports from env, Python-only keys dropped', () => {
    const o = toSdkOptions({ account: 'a', host: 'a.privatelink.snowflakecomputing.com', port: '8443', protocol: 'https', login_timeout: 30, ocsp_fail_open: true }, ce);
    assert.deepEqual(o, { account: 'a', host: 'a.privatelink.snowflakecomputing.com', port: 8443, protocol: 'https' });
  });

  it('upper-case keys are accepted too', () => {
    assert.deepEqual(toSdkOptions({ ACCOUNT: 'a', USER: 'u' }, ce), { account: 'a', username: 'u' });
  });
});

describe('config: the real snowflake-sdk accepts what we produce', () => {
  snowflake.configure({ logLevel: 'OFF' } as snowflake.ConfigureOptions);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bqx-sf-'));
  const keyPath = path.join(tmp, 'rsa_key.p8');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const tokenPath = path.join(tmp, 'token.txt');
  fs.writeFileSync(tokenPath, 'tok');
  const real = { platform: process.platform, homedir: os.homedir(), readFile: (p: string) => fs.readFileSync(p, 'utf8') };

  const cases: Record<string, Record<string, unknown>> = {
    password: { account: 'a', user: 'u', password: 'p' },
    externalbrowser: { account: 'a', user: 'u', authenticator: 'externalbrowser' },
    okta: { account: 'a', user: 'u', password: 'p', authenticator: 'https://acme.okta.com' },
    'key pair (file)': { account: 'a', user: 'u', private_key_file: keyPath },
    'key pair (inline)': { account: 'a', user: 'u', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    oauth: { account: 'a', user: 'u', authenticator: 'oauth', token: 't' },
    'oauth token file': { account: 'a', user: 'u', authenticator: 'oauth', token_file_path: tokenPath },
    pat: { account: 'a', user: 'u', authenticator: 'programmatic_access_token', token: 't' },
    mfa: { account: 'a', user: 'u', password: 'p', authenticator: 'username_password_mfa', passcode: '123456' },
    'oauth authorization code': { account: 'a', authenticator: 'oauth_authorization_code', oauth_client_id: 'id', oauth_client_secret: 's' },
    'oauth client credentials': { account: 'a', authenticator: 'oauth_client_credentials', oauth_client_id: 'id', oauth_client_secret: 's', oauth_token_request_url: 'https://idp.example.com/token' },
    'workload identity': { account: 'a', authenticator: 'workload_identity', workload_identity_provider: 'AWS' },
  };
  for (const [name, params] of Object.entries(cases)) {
    it(name, () => {
      const opts = toSdkOptions(params, real);
      assert.doesNotThrow(() => snowflake.createConnection(opts as snowflake.ConnectionOptions));
    });
  }
});
