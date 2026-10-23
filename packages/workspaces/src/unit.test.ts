import { describe, expect, it } from 'vitest';
import { renderInvitationMail } from './mail';
import { RESERVED_SLUGS, SLUG_PATTERN, slugProblem, slugify } from './slug';
import { deriveInvitationKey, hashInvitationToken, invitationToken, isWellFormedToken } from './token';

const ID = '01900000-0000-7000-8000-000000000001';

describe('slugs', () => {
  it('every reserved word is itself a well-formed slug (so the list can actually block something)', () => {
    for (const slug of RESERVED_SLUGS) expect(SLUG_PATTERN.test(slug), slug).toBe(true);
  });

  it('classifies format and reserved problems', () => {
    expect(slugProblem('sharma-taxi')).toBeNull();
    expect(slugProblem('www')).toBe('reserved');
    expect(slugProblem('freelancenter')).toBe('reserved');
    for (const bad of ['ab', 'Abc', 'a_b', '-ab', 'ab-', 'a--b', 'x'.repeat(49), 'ab c']) {
      expect(slugProblem(bad), bad).toBe('format');
    }
  });

  it('slugify always yields a well-formed proposal', () => {
    for (const name of ['Sharma Taxi', '  ', '!!', 'अग्रवाल स्टोर', 'A', 'x'.repeat(100), 'Ça va—Studio']) {
      expect(slugProblem(slugify(name)) === 'format', name).toBe(false);
    }
  });
});

describe('invitation tokens', () => {
  const key = deriveInvitationKey('unit-test-secret-unit-test-secret-0123');

  it('are 256-bit, URL-safe, deterministic per id and key, and stored only as SHA-256', () => {
    const token = invitationToken(key, ID);
    expect(isWellFormedToken(token)).toBe(true);
    expect(invitationToken(key, ID)).toBe(token);
    expect(invitationToken(key, '01900000-0000-7000-8000-000000000002')).not.toBe(token);
    expect(invitationToken(deriveInvitationKey('another-secret-another-secret-0123456'), ID)).not.toBe(token);
    expect(hashInvitationToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects short secrets and malformed tokens', () => {
    expect(() => deriveInvitationKey('short')).toThrow(RangeError);
    for (const bad of ['', 'abc', `${'a'.repeat(42)}!`, 'a'.repeat(44)])
      expect(isWellFormedToken(bad)).toBe(false);
  });
});

describe('invitation mail', () => {
  it('escapes the tenant-controlled workspace name and keeps the subject on one line', () => {
    const mail = renderInvitationMail(
      {
        workspaceName: '<script>alert(1)</script>\r\nBcc: x@example.test',
        role: 'editor',
        url: 'http://localhost:3000/invite/abc',
        expiresAt: new Date('2026-10-30T00:00:00Z'),
      },
      'Platform',
    );
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.text).toContain('http://localhost:3000/invite/abc');
    expect(mail.text).toContain('an editor');
  });
});
