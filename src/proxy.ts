/**
 * Pure proxy logic shared by the Bun server (src/index.ts).
 *
 * The Cloudflare Worker (worker/worker.js) implements the same path contract,
 * key allowlist, and CORS behaviour — keep those in sync. Two differences are
 * intentional, because the runtimes differ:
 *
 *   - Header stripping: Bun also drops `accept-encoding` (and deletes
 *     `content-encoding`/`content-length` on the way back) because Bun's
 *     fetch() transparently decompresses, which would leave the re-served
 *     response mislabelled. Workers stream the encoded body through untouched,
 *     so the Worker must not strip these.
 *   - `host`/`connection` are dropped here; the Workers runtime manages both
 *     itself, so the Worker leaves them alone.
 */

export const UPSTREAMS: Record<string, string> = {
  identitytoolkit: 'identitytoolkit.googleapis.com',
  securetoken: 'securetoken.googleapis.com',
  remoteconfig: 'firebaseremoteconfig.googleapis.com',
  installations: 'firebaseinstallations.googleapis.com',
  gtm: 'www.googletagmanager.com',
  ga: 'region1.google-analytics.com',
};

/** Prefixes that carry a Firebase API key we can validate. */
export const KEYED_PREFIXES = new Set([
  'identitytoolkit',
  'securetoken',
  'remoteconfig',
  'installations',
]);

/**
 * Resolve a request path like /identitytoolkit/v1/accounts:lookup to its
 * upstream URL. Returns null for unknown prefixes.
 */
export function resolveTarget(pathname: string, search: string): {
  prefix: string;
  url: string;
} | null {
  const slash = pathname.indexOf('/', 1);
  const prefix = pathname.slice(1, slash === -1 ? undefined : slash);
  const upstream = UPSTREAMS[prefix];
  if (!upstream) {
    return null;
  }
  const targetPath = slash === -1 ? '/' : pathname.slice(slash);
  return { prefix, url: `https://${upstream}${targetPath}${search}` };
}

/** Extract the Firebase API key from query param or header. */
export function extractApiKey(url: URL, headers: Headers): string | null {
  return url.searchParams.get('key') ?? headers.get('x-goog-api-key');
}

/**
 * Parse the comma-separated allowlist, tolerating spaces around commas,
 * trailing commas, and whitespace-only values.
 */
export function parseAllowedKeys(allowedCsv: string | undefined): string[] {
  return (allowedCsv ?? '')
    .split(',')
    .map(key => key.trim())
    .filter(Boolean);
}

/**
 * Check a key against the comma-separated allowlist. An unset, empty, or
 * whitespace-only allowlist allows everything — the proxy is then open to
 * any Firebase project's traffic.
 */
export function isKeyAllowed(
  key: string | null,
  allowedCsv: string | undefined
): boolean {
  const allowed = parseAllowedKeys(allowedCsv);
  if (allowed.length === 0) {
    return true;
  }
  return key !== null && allowed.includes(key);
}

/** CORS headers for both preflight responses and proxied responses. */
export function buildCorsHeaders(
  origin: string | null,
  requestedHeaders: string | null,
  allowedOriginsCsv: string | undefined
): Record<string, string> {
  const allowed = (allowedOriginsCsv || '*').split(',');
  const allowOrigin = allowed.includes('*')
    ? '*'
    : origin && allowed.includes(origin)
      ? origin
      : allowed[0]!;
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      requestedHeaders || 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Request headers that must not be forwarded to the upstream. */
const STRIPPED_REQUEST_HEADERS = ['host', 'cookie', 'connection', 'accept-encoding'];

/** Build the header set to forward upstream. */
export function buildForwardHeaders(incoming: Headers): Headers {
  const headers = new Headers(incoming);
  for (const name of STRIPPED_REQUEST_HEADERS) {
    headers.delete(name);
  }
  return headers;
}
