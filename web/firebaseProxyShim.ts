/**
 * Client-side shim that reroutes Firebase JS SDK traffic through your reverse
 * proxy. The SDK hardcodes Google hostnames, so we intercept fetch() (and
 * sendBeacon for Analytics) and rewrite known hosts to proxy path prefixes.
 *
 * MUST run before initializeApp() / the first Firebase call:
 *
 *   import { installFirebaseProxy, isFirebaseReachable } from './firebaseProxyShim';
 *
 *   // Option A — explicit (e.g. a China-specific build or domain):
 *   installFirebaseProxy('https://fb-api.example.com');
 *
 *   // Option B — probe first (adds up to `timeoutMs` before Firebase init):
 *   if (!(await isFirebaseReachable())) {
 *     installFirebaseProxy('https://fb-api.example.com');
 *   }
 *
 * Web only. React Native apps using @react-native-firebase talk to Google
 * from native code and are NOT covered by this shim.
 */

const HOST_TO_PREFIX: Record<string, string> = {
  'identitytoolkit.googleapis.com': 'identitytoolkit',
  'securetoken.googleapis.com': 'securetoken',
  'firebaseremoteconfig.googleapis.com': 'remoteconfig',
  'firebaseinstallations.googleapis.com': 'installations',
  'www.googletagmanager.com': 'gtm',
  'www.google-analytics.com': 'ga',
  'region1.google-analytics.com': 'ga',
  'analytics.google.com': 'ga',
};

let installed = false;

export function installFirebaseProxy(proxyOrigin: string): void {
  if (installed) return;
  installed = true;

  const base = proxyOrigin.replace(/\/$/, '');

  const rewrite = (rawUrl: string): string => {
    try {
      const u = new URL(rawUrl);
      const prefix = HOST_TO_PREFIX[u.hostname];
      if (!prefix) return rawUrl;
      return `${base}/${prefix}${u.pathname}${u.search}`;
    } catch {
      return rawUrl;
    }
  };

  const origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string') return origFetch(rewrite(input), init);
    if (input instanceof URL) return origFetch(rewrite(input.href), init);
    if (input instanceof Request) {
      const rewritten = rewrite(input.url);
      return rewritten === input.url
        ? origFetch(input, init)
        : origFetch(new Request(rewritten, input), init);
    }
    return origFetch(input as RequestInfo, init);
  }) as typeof fetch;

  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) =>
      origBeacon(rewrite(String(url)), data);
  }
}

/**
 * Quick reachability probe for Google endpoints. Resolves true if the network
 * path works (an opaque no-cors response still counts), false on timeout or
 * network error — i.e. false means "behind the block, install the proxy".
 */
export async function isFirebaseReachable(timeoutMs = 3000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch('https://firebaseinstallations.googleapis.com/generate_204', {
      mode: 'no-cors',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
