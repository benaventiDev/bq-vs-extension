import { GoogleAuth, type AuthClient } from 'google-auth-library';

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

let cached: Promise<{ client: AuthClient; projectId: string }> | null = null;

function loadAuth(): Promise<{ client: AuthClient; projectId: string }> {
  if (!cached) {
    cached = (async () => {
      const auth = new GoogleAuth({ scopes: [BQ_SCOPE] });
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
  return { token, projectId: ctx.projectId };
}
