import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GoogleAuth, type AuthClient } from 'google-auth-library';
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';

// Shared Application Default Credentials client for talking to the BigQuery
// REST API directly — avoids the ~3.3s Python cold start the `bq` CLI pays on
// every invocation. The auth client (and its internal token cache) is created
// once and reused for the life of the extension host, so after the first call
// each request is just the API round-trip.

const BQ_SCOPE = 'https://www.googleapis.com/auth/bigquery';
export const BIGQUERY_API_BASE = 'https://bigquery.googleapis.com/bigquery/v2';

/**
 * ADC credentials couldn't be loaded, or a request was rejected for auth
 * reasons. Callers fall back to the `bq` CLI so users who only set up
 * `gcloud auth login` (not `application-default login`) still work.
 */
export class CredentialError extends Error {}

/**
 * A transient transport problem (network error, unexpected non-JSON response)
 * where retrying via the `bq` CLI is the safest recovery.
 */
export class FallbackError extends Error {}

// A connection that a VPN/firewall silently drops would otherwise hang ~20s
// before failing. Only connection setup is bounded — a slow server-side
// response (e.g. a heavy dry-run) is never cut short.
const CONNECT_TIMEOUT_MS = 3000;

/**
 * The HTTP(S) proxy configured for the gcloud CLI (`gcloud config set
 * proxy/...`), if any. On networks where only the CLI was set up for the
 * proxy, this is the one place it's recorded — env vars and VS Code's
 * http.proxy are often empty. SOCKS proxies aren't supported here and are
 * ignored (the bq CLI fallback still handles them).
 */
function gcloudProxyUrl(): string | undefined {
  try {
    const configDir =
      process.env.CLOUDSDK_CONFIG ||
      (process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? os.homedir(), 'gcloud')
        : path.join(os.homedir(), '.config', 'gcloud'));
    let active = process.env.CLOUDSDK_ACTIVE_CONFIG_NAME;
    if (!active) {
      try {
        active = fs.readFileSync(path.join(configDir, 'active_config'), 'utf8').trim();
      } catch {
        active = 'default';
      }
    }
    const ini = fs.readFileSync(
      path.join(configDir, 'configurations', `config_${active || 'default'}`),
      'utf8',
    );
    const proxy: Record<string, string> = {};
    let section = '';
    for (const raw of ini.split(/\r?\n/)) {
      const line = raw.trim();
      const header = /^\[(.+)\]$/.exec(line);
      if (header) {
        section = header[1].trim();
        continue;
      }
      const kv = /^([^=]+)=(.*)$/.exec(line);
      if (kv && section === 'proxy') proxy[kv[1].trim()] = kv[2].trim();
    }
    const type = (proxy.type || 'http').toLowerCase();
    if (!proxy.address || !proxy.port || (type !== 'http' && type !== 'https')) {
      return undefined;
    }
    const auth = proxy.username
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@`
      : '';
    return `${type}://${auth}${proxy.address}:${proxy.port}`;
  } catch {
    return undefined;
  }
}

/**
 * NO_PROXY match, curl-style: `*` matches everything; `example.com`,
 * `.example.com` and `*.example.com` all match the domain and its subdomains.
 */
function bypassesProxy(host: string): boolean {
  const rules = (process.env.NO_PROXY ?? process.env.no_proxy ?? '')
    .split(',')
    .map((r) => r.trim().toLowerCase().replace(/:\d+$/, ''))
    .filter(Boolean);
  const h = host.toLowerCase();
  return rules.some((rule) => {
    if (rule === '*') return true;
    const domain = rule.replace(/^\*?\./, '');
    return h === domain || h.endsWith(`.${domain}`);
  });
}

let cached: Promise<{ client: AuthClient; projectId: string }> | null = null;

function loadAuth(): Promise<{ client: AuthClient; projectId: string }> {
  if (!cached) {
    cached = (async () => {
      // Proxy precedence: HTTPS_PROXY / HTTP_PROXY, then the gcloud CLI's
      // proxy. NO_PROXY is honoured either way.
      const envProxy =
        process.env.HTTPS_PROXY || process.env.https_proxy ||
        process.env.HTTP_PROXY || process.env.http_proxy;
      const proxy = envProxy || gcloudProxyUrl();
      // Requests go through undici with an explicit dispatcher rather than
      // node's `https` module or the global `fetch`: VS Code's proxy support
      // patches both and replaces our proxy agent with whatever *it* resolves
      // (often "direct", which a corporate network silently drops).
      const direct = new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS } });
      const viaProxy = proxy
        ? new ProxyAgent({ uri: proxy, proxyTls: { timeout: CONNECT_TIMEOUT_MS } })
        : undefined;
      const fetchImplementation = ((url: string | URL, init?: RequestInit) => {
        const host = new URL(url).hostname;
        const dispatcher = viaProxy && !bypassesProxy(host) ? viaProxy : direct;
        return undiciFetch(url, { ...(init as object), dispatcher } as never);
      }) as unknown as typeof fetch;
      const auth = new GoogleAuth({
        scopes: [BQ_SCOPE],
        // Applies to every request on the client's transporter — token
        // refreshes as well as bqPostJson.
        clientOptions: {
          transporterOptions: {
            fetchImplementation,
            // Don't retry requests that never got a response (blocked or
            // timed-out connections) — the bq CLI fallback is the retry.
            retryConfig: { noResponseRetries: 0 },
          },
        },
      });
      // getProjectId resolves from GOOGLE_CLOUD_PROJECT, the ADC file, or the
      // gcloud config — the same project the user already runs bq against.
      const [client, projectId] = await Promise.all([
        auth.getClient(),
        auth.getProjectId(),
      ]);
      return { client, projectId };
    })().catch((err) => {
      // Don't poison the cache on a transient failure — let the next call retry.
      cached = null;
      throw err;
    });
  }
  return cached;
}

export interface BqAccess {
  token: string;
  projectId: string;
  client: AuthClient;
}

export interface BqResponse<T> {
  status: number;
  data: T | null;
}

/**
 * POST JSON to the BigQuery API through the auth client's transporter, so it
 * shares the proxy-aware undici dispatcher set up in loadAuth (env proxy or
 * the gcloud CLI's proxy; direct when neither is configured).
 * Never throws on HTTP status — only on transport errors or abort.
 */
export async function bqPostJson<T>(
  access: BqAccess,
  url: string,
  body: unknown,
  signal: AbortSignal,
): Promise<BqResponse<T>> {
  const res = await access.client.transporter.request<T>({
    url,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access.token}`,
      'Content-Type': 'application/json',
    },
    data: body,
    signal,
    responseType: 'json',
    validateStatus: () => true,
    retry: false,
  });
  const data = res.data && typeof res.data === 'object' ? res.data : null;
  return { status: res.status, data };
}

/**
 * Resolve a usable access token + project id from ADC, reusing the cached
 * client (and its token cache) across calls. Throws {@link CredentialError}
 * when ADC isn't available so the caller can fall back to the CLI.
 */
export async function bqAccessContext(): Promise<BqAccess> {
  let ctx: { client: AuthClient; projectId: string };
  try {
    ctx = await loadAuth();
  } catch {
    throw new CredentialError(
      'Could not load Google Cloud Application Default Credentials. ' +
        'Run "gcloud auth application-default login".',
    );
  }
  let token: string | null | undefined;
  try {
    token = (await ctx.client.getAccessToken()).token;
  } catch {
    throw new CredentialError(
      'Failed to obtain a Google Cloud access token. ' +
        'Run "gcloud auth application-default login".',
    );
  }
  if (!token) {
    throw new CredentialError('Empty Google Cloud access token.');
  }
  return { token, projectId: ctx.projectId, client: ctx.client };
}
