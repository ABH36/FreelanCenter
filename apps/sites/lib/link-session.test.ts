import { describe, expect, it } from 'vitest';
import { CLEAN_PATH, cookieToken, exchangeResponse, linkCookie, linkKey } from './link-session';

// P3 S9b (DG-37 (h)): the link cookie and the clean path.
describe('link session', () => {
  const req = (cookie?: string) => new Request('https://x.test/', cookie ? { headers: { cookie } } : {});

  it('reads only its own cookie name, and only a token-shaped value', () => {
    expect(cookieToken(req('a=1; __Secure-link=s1.abc.def; b=2'), true)).toBe('s1.abc.def');
    expect(cookieToken(req('link=s1.abc.def'), true)).toBeNull();
    expect(cookieToken(req('link=s1.abc.def'), false)).toBe('s1.abc.def');
    expect(cookieToken(req('__Secure-link=<script>'), true)).toBeNull();
    expect(cookieToken(req('__Secure-link='), true)).toBeNull();
    expect(cookieToken(req(`__Secure-link=${'a'.repeat(701)}`), true)).toBeNull();
    expect(cookieToken(req(), true)).toBeNull();
  });

  it('the key is the link id, or a stable digest that matches the clean path and never contains the token', () => {
    const id = '01920000-0000-7000-8000-0000000000c1';
    expect(linkKey('anything', id)).toBe(id);
    expect(linkKey('v1.aaa.bbb', 'NOT-A-UUID')).toBe(linkKey('v1.aaa.bbb'));
    const key = linkKey('v1.aaa.bbb');
    expect(key).toBe(linkKey('v1.aaa.bbb'));
    expect(key).not.toBe(linkKey('v1.aaa.bbc'));
    expect(CLEAN_PATH.preview.test(`/preview/${key}/rates`)).toBe(true);
    expect(CLEAN_PATH.review.test(`/review/${id}`)).toBe(true);
    expect(key).not.toContain('aaa');
  });

  it('the cookie lives no longer than the token and at least one second', () => {
    const base = { kind: 'review' as const, key: 'k'.repeat(8), token: 't', secure: true };
    expect(linkCookie({ ...base, expiresAt: 1_000, now: 400 })).toContain('Max-Age=600');
    expect(linkCookie({ ...base, expiresAt: 1_000, now: 1_000 })).toContain('Max-Age=1');
  });

  it('the redirect stays on this host: an odd page path cannot make it leave', () => {
    const res = exchangeResponse({
      kind: 'review',
      key: 'k'.repeat(8),
      token: 't',
      rest: '//evil.example/x',
      search: '',
      expiresAt: 2,
      now: 1,
      secure: true,
      correlationId: undefined,
    });
    const location = res.headers.get('location')!;
    expect(location.startsWith('/review/')).toBe(true);
    expect(new URL(location, 'https://preview.example').host).toBe('preview.example');
  });
});
