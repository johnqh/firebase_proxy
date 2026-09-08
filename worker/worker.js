/**
 * Firebase reverse proxy for regions where *.googleapis.com is blocked.
 *
 * Path-prefix routing:
 *   /identitytoolkit/*  -> identitytoolkit.googleapis.com        (Auth)
 *   /securetoken/*      -> securetoken.googleapis.com            (Auth token refresh)
 *   /remoteconfig/*     -> firebaseremoteconfig.googleapis.com   (Remote Config)
 *   /installations/*    -> firebaseinstallations.googleapis.com  (FIS — required by Remote Config + Analytics)
 *   /gtm/*              -> www.googletagmanager.com              (gtag.js script)
 *   /ga/*               -> region1.google-analytics.com          (Analytics collect)
 *
 * Env vars (wrangler.toml [vars] or dashboard):
 *   ALLOWED_API_KEYS  comma-separated Firebase Web API keys this proxy will serve.
 *                     Leave unset to disable the check (not recommended — an open
 *                     proxy to googleapis.com will get abused).
 *   ALLOWED_ORIGINS   comma-separated web origins for CORS, or "*".
 */

const UPSTREAMS = {
  identitytoolkit: 'identitytoolkit.googleapis.com',
  securetoken: 'securetoken.googleapis.com',
  remoteconfig: 'firebaseremoteconfig.googleapis.com',
  installations: 'firebaseinstallations.googleapis.com',
  gtm: 'www.googletagmanager.com',
  ga: 'region1.google-analytics.com',
};

// Prefixes that carry a Firebase API key we can validate.
const KEYED_PREFIXES = new Set(['identitytoolkit', 'securetoken', 'remoteconfig', 'installations']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' });
    }

    const slash = url.pathname.indexOf('/', 1);
    const prefix = url.pathname.slice(1, slash === -1 ? undefined : slash);
    const upstream = UPSTREAMS[prefix];
    if (!upstream) {
      return new Response('not found', { status: 404 });
    }

    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env, origin) });
    }

    // An unset/empty allowlist allows everything — the proxy is then open
    // to any Firebase project's traffic.
    const allowedKeys = (env.ALLOWED_API_KEYS || '')
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);
    if (KEYED_PREFIXES.has(prefix) && allowedKeys.length > 0) {
      const key = url.searchParams.get('key') || request.headers.get('x-goog-api-key');
      if (!allowedKeys.includes(key)) {
        return new Response('forbidden', { status: 403 });
      }
    }

    const targetPath = slash === -1 ? '/' : url.pathname.slice(slash);
    const target = `https://${upstream}${targetPath}${url.search}`;

    const headers = new Headers(request.headers);
    headers.delete('cookie');

    const upstreamResp = await fetch(target, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    });

    const respHeaders = new Headers(upstreamResp.headers);
    for (const [k, v] of Object.entries(corsHeaders(request, env, origin))) {
      respHeaders.set(k, v);
    }
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: respHeaders,
    });
  },
};

function corsHeaders(request, env, origin) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',');
  const allowOrigin =
    allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      request.headers.get('Access-Control-Request-Headers') || 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
