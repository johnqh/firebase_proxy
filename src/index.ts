/**
 * Firebase reverse proxy — Bun server variant for Docker deployment
 * (sudobility_dockerized / Traefik). Same path-prefix contract as the
 * Cloudflare Worker in worker/worker.js.
 *
 * Env:
 *   PORT              listen port (required by sudobility_dockerized/Doppler)
 *   ALLOWED_API_KEYS  comma-separated Firebase Web API keys to serve;
 *                     unset disables the check (not recommended)
 *   ALLOWED_ORIGINS   comma-separated CORS origins, or "*" (default)
 */

import {
  buildCorsHeaders,
  buildForwardHeaders,
  extractApiKey,
  isKeyAllowed,
  KEYED_PREFIXES,
  resolveTarget,
} from './proxy';

const PORT = Number(process.env.PORT ?? 8080);

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/health') {
    return Response.json({ status: 'ok' });
  }

  const cors = buildCorsHeaders(
    request.headers.get('Origin'),
    request.headers.get('Access-Control-Request-Headers'),
    process.env.ALLOWED_ORIGINS
  );

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const target = resolveTarget(url.pathname, url.search);
  if (!target) {
    return new Response('not found', { status: 404 });
  }

  if (
    KEYED_PREFIXES.has(target.prefix) &&
    !isKeyAllowed(extractApiKey(url, request.headers), process.env.ALLOWED_API_KEYS)
  ) {
    return new Response('forbidden', { status: 403 });
  }

  const upstreamResp = await fetch(target.url, {
    method: request.method,
    headers: buildForwardHeaders(request.headers),
    body: request.body,
    redirect: 'manual',
  });

  const headers = new Headers(upstreamResp.headers);
  // fetch() already decompressed the body; the stale encoding headers would
  // corrupt the re-served response.
  headers.delete('content-encoding');
  headers.delete('content-length');
  for (const [name, value] of Object.entries(cors)) {
    headers.set(name, value);
  }
  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers,
  });
}

Bun.serve({
  port: PORT,
  fetch: handle,
});

console.log(`firebase-proxy listening on :${PORT}`);
