/**
 * Pure S6 rules: the transition table cell by cell (FR-PRJ-02), subdomain labels (Q9), audit CSV safety and
 * filters (FR-AUD-01), LIKE escaping (FR-PRJ-04), notification categories and mail escaping (FR-NOT-01).
 */
import { describe, expect, it } from 'vitest';
import { WORKSPACE_ROLES, can } from '@platform/auth/rbac';
import { csvCell, parseAuditFilters, toCsv } from './audit';
import { PROJECT_STATUSES, findTransition, transitionsFrom } from './lifecycle';
import { renderNotificationMail } from './mail';
import { CATEGORY_NAMES, NOTIFICATION_CATEGORIES, categoryOf, emailWanted } from './notifications';
import { likePattern, parseStatusFilter } from './projects';
import { RESERVED_SLUGS, subdomainLabel } from './slug';

/** The expected table, written out independently of lifecycle.ts: from -> to -> roles. */
const EXPECTED: Record<string, string[]> = {
  'draft>in_review': ['owner', 'admin', 'editor'],
  'draft>archived': ['owner', 'admin'],
  'in_review>draft': ['owner', 'admin', 'editor'],
  'in_review>approved': ['owner', 'admin'],
  'in_review>archived': ['owner', 'admin'],
  'approved>draft': ['owner', 'admin', 'editor'],
  'approved>live': ['owner', 'admin'],
  'approved>archived': ['owner', 'admin'],
  'live>paused': ['owner', 'admin'],
  'live>archived': ['owner', 'admin'],
  'paused>live': ['owner', 'admin'],
  'paused>archived': ['owner', 'admin'],
  'archived>draft': ['owner', 'admin'],
};

describe('transition table (36 pairs x 4 roles)', () => {
  it.each(PROJECT_STATUSES.flatMap((from) => PROJECT_STATUSES.map((to) => ({ from, to }))))(
    '$from -> $to',
    ({ from, to }) => {
      const t = findTransition(from, to);
      const roles = t
        ? WORKSPACE_ROLES.filter((role) =>
            can({ kind: 'member', userId: 'u', workspaceId: 'w', role }, t.capability),
          )
        : null;
      expect(roles).toEqual(EXPECTED[`${from}>${to}`] ?? null);
    },
  );

  it('editors may not go live even though the table is role-based (policy off by default)', () => {
    const live = findTransition('approved', 'live')!;
    expect(can({ kind: 'member', userId: 'u', workspaceId: 'w', role: 'editor' }, live.capability)).toBe(
      false,
    );
    expect(transitionsFrom('archived').map((t) => t.to)).toEqual(['draft']);
  });
});

describe('subdomain labels (Q9)', () => {
  it.each([
    ['Sharma Taxi', 'sharma-taxi'],
    ['  Café  Délice!! ', 'cafe-delice'],
    ['A', 'a-site'],
    ['शर्मा', 'site'],
    ['x'.repeat(60), 'x'.repeat(40)],
    ['Hello -- World', 'hello-world'],
    ['a'.repeat(39) + ' b', 'a'.repeat(39)],
  ])('%s -> %s', (name, label) => {
    expect(subdomainLabel(name)).toBe(label);
  });

  it('always fits the allocator pattern, and `site` is reserved (so it always gets a suffix)', () => {
    for (const name of ['', '!!!', 'é', 'Hello World', '-x-', '9'.repeat(100)]) {
      expect(subdomainLabel(name)).toMatch(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/);
      expect(subdomainLabel(name)).not.toContain('--');
    }
    expect(RESERVED_SLUGS.has('site')).toBe(true);
  });
});

describe('audit CSV and filters (FR-AUD-01)', () => {
  it('neutralises formulas and quotes separators', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"\nnext')).toBe('"say ""hi""\nnext"');
    expect(csvCell(null)).toBe('');
    expect(csvCell({ name: '=x' })).toBe('"{""name"":""=x""}"');
  });

  it('writes a header and one CRLF line per row', () => {
    const csv = toCsv([
      {
        id: 'i',
        createdAt: new Date('2026-10-24T00:00:00Z'),
        action: 'project.created',
        result: 'success',
        actorType: 'user',
        actorId: 'a',
        actorName: '=evil',
        targetType: 'project',
        targetId: 't',
        projectId: 't',
        correlationId: null,
        metadata: {},
      },
    ]);
    expect(csv.split('\r\n')).toHaveLength(3);
    expect(csv).toContain(",'=evil,");
  });

  it('drops malformed filters instead of passing them on', () => {
    expect(
      parseAuditFilters({ action: "x'; DROP", result: 'maybe', actorId: 'nope', from: '2026-13-45' }),
    ).toEqual({
      action: null,
      result: null,
      actorId: null,
      from: null,
      to: null,
    });
    const f = parseAuditFilters({
      action: 'project.',
      result: 'denied',
      from: '2026-10-01',
      to: '2026-10-01',
    });
    expect(f.action).toBe('project.');
    expect(f.to!.getTime() - f.from!.getTime()).toBe(86_400_000);
  });
});

describe('project list helpers (FR-PRJ-04)', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(likePattern('100%')).toBe('100\\%');
    expect(likePattern('a_b')).toBe('a\\_b');
    expect(likePattern('c\\d')).toBe('c\\\\d');
  });

  it('status filter defaults to active (everything but archived)', () => {
    expect(parseStatusFilter(undefined)).toBe('active');
    expect(parseStatusFilter('bogus')).toBe('active');
    expect(parseStatusFilter('all')).toBe('all');
    expect(parseStatusFilter('live')).toBe('live');
  });
});

describe('notifications (FR-NOT-01)', () => {
  it('every type belongs to exactly one category; e-mail only where a path exists', () => {
    const types = CATEGORY_NAMES.flatMap((c) => [...NOTIFICATION_CATEGORIES[c].types]);
    expect(new Set(types).size).toBe(types.length);
    expect(categoryOf('project.review_requested')).toBe('project.review');
    expect(categoryOf('unknown.type')).toBeNull();
    expect(emailWanted('workspace.members', true)).toBe(false);
    expect(emailWanted('project.review', undefined)).toBe(true);
    expect(emailWanted('project.review', false)).toBe(false);
  });

  it('escapes tenant input in the e-mail and caps its length', () => {
    const mail = renderNotificationMail(
      {
        type: 'project.status_changed',
        workspaceName: '<b>WS</b>',
        projectName: '<script>alert(1)</script>' + 'x'.repeat(300),
        payload: { to: 'live' },
        url: 'http://localhost:3000/w/ws/notifications',
      },
      'Platform',
    );
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;b&gt;WS&lt;/b&gt;');
    expect(mail.subject.length).toBeLessThanOrEqual(200);
    expect(mail.text).toContain('is now Live');
  });
});
