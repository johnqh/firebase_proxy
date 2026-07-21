import { describe, expect, it } from 'bun:test';

import {
  buildCorsHeaders,
  buildForwardHeaders,
  extractApiKey,
  isKeyAllowed,
  resolveTarget,
} from './proxy';

describe('resolveTarget', () => {
  it('maps each prefix to its upstream, preserving path and query', () => {
    expect(
      resolveTarget('/identitytoolkit/v1/accounts:signInWithPassword', '?key=k')
    ).toEqual({
      prefix: 'identitytoolkit',
      url: 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k',
    });
    expect(resolveTarget('/securetoken/v1/token', '?key=k')?.url).toBe(
      'https://securetoken.googleapis.com/v1/token?key=k'
    );
    expect(resolveTarget('/ga/g/collect', '?v=2')?.url).toBe(
      'https://region1.google-analytics.com/g/collect?v=2'
    );
    expect(resolveTarget('/gtm/gtag/js', '?id=G-X')?.url).toBe(
      'https://www.googletagmanager.com/gtag/js?id=G-X'
    );
  });

  it('handles a bare prefix with no trailing path', () => {
    expect(resolveTarget('/installations', '')?.url).toBe(
      'https://firebaseinstallations.googleapis.com/'
    );
  });

  it('returns null for unknown prefixes', () => {
    expect(resolveTarget('/evil/path', '')).toBeNull();
    expect(resolveTarget('/', '')).toBeNull();
  });
});

describe('extractApiKey', () => {
  it('prefers the key query param', () => {
    const url = new URL('https://p.example.com/securetoken/v1/token?key=from-query');
    const headers = new Headers({ 'x-goog-api-key': 'from-header' });
    expect(extractApiKey(url, headers)).toBe('from-query');
  });

  it('falls back to the x-goog-api-key header', () => {
    const url = new URL('https://p.example.com/installations/v1/x');
    const headers = new Headers({ 'x-goog-api-key': 'from-header' });
    expect(extractApiKey(url, headers)).toBe('from-header');
  });

  it('returns null when neither is present', () => {
    expect(
      extractApiKey(new URL('https://p.example.com/x'), new Headers())
    ).toBeNull();
  });
});

describe('isKeyAllowed', () => {
  it('allows listed keys and rejects others', () => {
    expect(isKeyAllowed('k1', 'k1,k2')).toBe(true);
    expect(isKeyAllowed('k3', 'k1,k2')).toBe(false);
    expect(isKeyAllowed(null, 'k1,k2')).toBe(false);
  });

  it('allows everything when no allowlist is configured', () => {
    expect(isKeyAllowed(null, undefined)).toBe(true);
    expect(isKeyAllowed('anything', '')).toBe(true);
  });

  it('treats whitespace-only and comma-only values as no allowlist', () => {
    expect(isKeyAllowed(null, '   ')).toBe(true);
    expect(isKeyAllowed(null, ',')).toBe(true);
    expect(isKeyAllowed('anything', ' , ')).toBe(true);
  });

  it('tolerates spaces around commas and trailing commas', () => {
    expect(isKeyAllowed('k2', 'k1, k2')).toBe(true);
    expect(isKeyAllowed('k1', 'k1,k2,')).toBe(true);
    expect(isKeyAllowed('k3', 'k1, k2,')).toBe(false);
  });
});

describe('buildCorsHeaders', () => {
  it('returns * when the allowlist is * or unset', () => {
    expect(buildCorsHeaders('https://a.com', null, '*')['Access-Control-Allow-Origin']).toBe('*');
    expect(buildCorsHeaders('https://a.com', null, undefined)['Access-Control-Allow-Origin']).toBe('*');
  });

  it('reflects a listed origin and falls back to the first entry otherwise', () => {
    const csv = 'https://a.com,https://b.com';
    expect(buildCorsHeaders('https://b.com', null, csv)['Access-Control-Allow-Origin']).toBe('https://b.com');
    expect(buildCorsHeaders('https://evil.com', null, csv)['Access-Control-Allow-Origin']).toBe('https://a.com');
  });

  it('echoes requested headers in preflight', () => {
    expect(
      buildCorsHeaders(null, 'X-Custom, Content-Type', '*')['Access-Control-Allow-Headers']
    ).toBe('X-Custom, Content-Type');
  });
});

describe('buildForwardHeaders', () => {
  it('strips hop-by-hop and sensitive headers, keeps the rest', () => {
    const incoming = new Headers({
      host: 'fb-api.example.com',
      cookie: 'session=abc',
      connection: 'keep-alive',
      'accept-encoding': 'gzip',
      'content-type': 'application/json',
      'x-goog-api-key': 'k',
    });
    const forwarded = buildForwardHeaders(incoming);
    expect(forwarded.get('host')).toBeNull();
    expect(forwarded.get('cookie')).toBeNull();
    expect(forwarded.get('connection')).toBeNull();
    expect(forwarded.get('accept-encoding')).toBeNull();
    expect(forwarded.get('content-type')).toBe('application/json');
    expect(forwarded.get('x-goog-api-key')).toBe('k');
  });
});
