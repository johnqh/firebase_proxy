# firebase-china-proxy

Reverse proxy + client shim so Firebase **Auth**, **Remote Config**, and
**Analytics** work for users in mainland China without a VPN. Three
interchangeable proxy implementations (Cloudflare Worker, Bun/Docker, nginx)
plus a web shim that reroutes the Firebase JS SDK through the proxy.

## How it fits together

```
browser in China
   │  https://fb-api.yourdomain.com/identitytoolkit/v1/accounts:signInWithPassword?key=...
   ▼
your proxy (Worker or nginx)          ── rewrites path prefix → real Google host
   │  https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=...
   ▼
Google
```

Path prefixes → upstreams:

| Prefix             | Upstream                              | Used by |
|--------------------|---------------------------------------|---------|
| `/identitytoolkit` | identitytoolkit.googleapis.com        | Auth sign-in/up, account ops |
| `/securetoken`     | securetoken.googleapis.com            | Auth ID-token refresh |
| `/remoteconfig`    | firebaseremoteconfig.googleapis.com   | Remote Config fetch |
| `/installations`   | firebaseinstallations.googleapis.com  | FIS — Remote Config & Analytics depend on it |
| `/gtm`             | www.googletagmanager.com              | gtag.js script |
| `/ga`              | region1.google-analytics.com          | Analytics collect |

## Deploy — Cloudflare Worker (easiest)

1. Edit `worker/wrangler.toml`: set your domain in `routes`.
2. Configure the two vars (no real values live in the repo):
   - Local dev: `cp worker/.dev.vars.example worker/.dev.vars` and fill it in
     (`.dev.vars` is gitignored, read automatically by `wrangler dev`).
   - Production: `cd worker && npx wrangler secret put ALLOWED_API_KEYS`
     then `npx wrangler secret put ALLOWED_ORIGINS`.
3. `cd worker && npx wrangler deploy`
4. Point DNS: the custom-domain route creates the record automatically if the
   zone is on Cloudflare.

Note: the Firebase Web API key is not a true secret (it ships in every client
bundle) — keeping it out of the repo is hygiene and per-environment
flexibility, not confidentiality.

Caveat: plain Cloudflare (non-China network) is *usually* reachable from the
mainland but throttling varies by ISP and time. If reliability matters, prefer
the nginx variant on a HK/SG/Tokyo VPS — or the gold standard: an ICP-filed
domain fronted by a Chinese CDN (Tencent/Ali) with this proxy as origin.

## Deploy — Docker (sudobility_dockerized)

A Bun server variant (`src/index.ts`) implements the same path contract and
key allowlist as the Worker, packaged by the root `Dockerfile`.

CI/CD (`.github/workflows/ci-cd.yml`) uses `johnqh/workflows` unified-cicd:
pushing to `main` with a bumped `package.json` version builds a multi-arch
image and pushes `johnqh/firebase_proxy:latest` + `:<version>` to Docker Hub
(requires `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` repo/org secrets, like
sudojo_api).

To deploy on the server via `sudobility_dockerized`:

1. Create a Doppler config for the service with:
   - `PORT` (required by add.sh, e.g. `8080`)
   - `ALLOWED_API_KEYS` — comma-separated Firebase Web API key(s)
   - `ALLOWED_ORIGINS` — comma-separated CORS origins, or `*`
2. Run `./add.sh` and enter:
   - Service name: `firebase_proxy`
   - Hostname: `fb-api.yourdomain.com` (DNS A record → server IP;
     Traefik provisions the Let's Encrypt cert automatically)
   - Image: `docker.io/johnqh/firebase_proxy:latest`
   - Health endpoint: `/health`
   - The Doppler service token
3. Later releases: bump the version, push to main, then `./upgrade.sh`.

Local dev: `PORT=8080 bun run dev`, tests with `bun test`.

## Deploy — nginx

1. Edit `nginx/firebase-proxy.conf`: server_name + cert paths.
2. Drop into `/etc/nginx/conf.d/`, `nginx -t && systemctl reload nginx`.
3. Set your Firebase Web API key(s) in the `map $fb_api_key $fb_key_allowed`
   block at the top of the file, replacing `REPLACE_WITH_WEB_API_KEY`. This is
   the nginx equivalent of `ALLOWED_API_KEYS`; unlike the other two variants it
   is **fail-closed** — until you edit it, every keyed request gets a 403.
   To run an open proxy deliberately, delete the `if ($fb_deny)` guards.

## Smoke test

```sh
# Should return a Firebase error JSON (INVALID_LOGIN_CREDENTIALS / MISSING_EMAIL),
# which proves the round trip to Google works:
curl -s 'https://fb-api.example.com/identitytoolkit/v1/accounts:signInWithPassword?key=YOUR_WEB_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"email":"probe@example.com","password":"x","returnSecureToken":true}'

# Wrong key should be rejected by the Worker itself:
curl -s 'https://fb-api.example.com/identitytoolkit/v1/accounts:signInWithPassword?key=nope' -d '{}'
```

## Wire up the web apps

Install the shim **before** `initializeApp()`. It ships in
`@sudobility/auth_lib` (web entry) as `src/config/firebase-proxy.ts`;
`web/firebaseProxyShim.ts` here is the standalone copy for apps that don't
use auth_lib. The library takes
`proxyOrigin` as a parameter — source it from the consuming app's own `.env`
(e.g. `VITE_FIREBASE_PROXY_ORIGIN=https://fb-api.example.com` in Vite apps):

```ts
import { installFirebaseProxy, isFirebaseReachable } from '@sudobility/auth_lib';

const proxyOrigin = import.meta.env.VITE_FIREBASE_PROXY_ORIGIN;
if (proxyOrigin && !(await isFirebaseReachable())) {
  installFirebaseProxy(proxyOrigin);
}
// ...then initializeApp(...) as usual
```

Leaving `VITE_FIREBASE_PROXY_ORIGIN` unset disables the proxy path entirely,
which doubles as a kill switch per environment.

The probe adds up to 3s on first load for blocked users only (it resolves
fast when Google is reachable). For a China-specific domain/build, skip the
probe and call `installFirebaseProxy` unconditionally.

### Analytics specifics

The shim rewrites the collect beacons, but the Analytics SDK also injects a
`<script src="https://www.googletagmanager.com/gtag/js...">` tag, which the
shim cannot rewrite. Two options:

- Accept it: gtag fails to load, events queue into `dataLayer` and are lost
  for China users. Auth/Remote Config are unaffected.
- Fully proxy it: before `initializeAnalytics`, load the script yourself from
  `https://fb-api.example.com/gtm/gtag/js?l=dataLayer&id=G-XXXX` and pass
  `{ config: { transport_url: 'https://fb-api.example.com/ga' } }` as
  `AnalyticsSettings` so collect traffic goes through `/ga`.

## Firebase console changes

- **Email action links** (verification / password reset) default to
  `https://<project>.firebaseapp.com/...` — blocked in China. Set a custom
  action URL (Authentication → Templates) on a domain you control, or handle
  the action codes in-app via `applyActionCode`.

## Known limits — a proxy cannot fix these

- **FCM push**: Android needs Google Play Services talking to Google's push
  backbone; Chrome web push uses Google's push service. Neither routes through
  your proxy. Use APNs on iOS (works in China) and a domestic provider
  (JPush/Getui) or polling on Android/web.
- **Google / OAuth sign-in popups**: `accounts.google.com` is blocked and
  proxying it breaks OAuth redirect validation (and ToS). Email/password and
  custom-token flows are fine.
- **reCAPTCHA** (web phone auth, App Check): blocked; avoid for China traffic.
- **React Native**: `@react-native-firebase` calls Google from native code —
  the fetch shim does not apply. The RN apps need a different strategy
  (usually: don't rely on Firebase for China-facing RN builds).

## Security notes

- All three proxy variants refuse requests whose `key`/`x-goog-api-key` isn't
  allowlisted, so they can't be used as a general googleapis proxy. The default
  when unconfigured differs, so check the one you deploy:
  - Worker and Bun: leaving `ALLOWED_API_KEYS` unset or empty is **open mode**
    — any Firebase project's traffic is forwarded.
  - nginx: **fail-closed** — the allowlist is a literal `map` in the config, so
    an unedited file rejects every keyed request.

  Open mode is only for a knowingly shared proxy — open relays get abused, and
  abuse burns the IP/domain reputation your China reachability depends on.
- The key check deliberately exempts `OPTIONS`: a CORS preflight carries no
  custom headers, so it cannot present `x-goog-api-key` (which is how
  Installations authenticates). Preflights are answered before the check in all
  three variants.
- Cookies are stripped before forwarding; Firebase's web SDKs don't need them.
- If you self-load gtag.js through `/gtm`, note that Subresource Integrity
  (`integrity="sha384-..."`) can't be used: Google rotates the script's
  contents, so any pinned hash would break it within days. The compensating
  controls are that it loads from your own domain over TLS and the proxy
  forwards only to `www.googletagmanager.com`. If that's not acceptable,
  self-host a vetted snapshot of gtag.js and update it deliberately — or drop
  Analytics for China traffic, since it's the only piece that needs a
  third-party script at all.
