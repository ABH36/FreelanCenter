/**
 * Read-only proof of the visitor client (`@platform/db/public`, app_public) against the deployed database through
 * its transaction pooler (P1 S7). Writes nothing. Optional `LIVE_SITE_HOST` names a host that must resolve to a
 * site or maintenance page. Run: `pnpm test:live` with DB URLs in .env.local.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDotEnv } from '../../src/env';
import { createPublicDatabase, type PublicDatabase } from '../../src/public';

const env = {
  ...parseDotEnv(readFileSync(new URL('../../../../.env.local', import.meta.url), 'utf8')),
  ...process.env,
};
let visitor: PublicDatabase;

beforeAll(() => {
  visitor = createPublicDatabase({ connectionString: env.DATABASE_URL_PUBLIC!, env });
});
afterAll(async () => {
  await visitor.close();
});

describe('live: app_public visitor path (P1 S7)', () => {
  it('connects as app_public without SUPERUSER or BYPASSRLS', async () => {
    await expect(visitor.verifyRole()).resolves.toBeUndefined();
  });

  it('an RFC 2606 .invalid host resolves to unknown; round trip timed', async () => {
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      await expect(visitor.resolveHost(`live-check-${i}.invalid`)).resolves.toEqual({ outcome: 'unknown' });
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    process.stdout.write(
      `live: resolve_host p50 ${Math.round(times[4]!)} ms (uncached, from this machine)\n`,
    );
  });

  it.skipIf(!env.LIVE_SITE_HOST)('LIVE_SITE_HOST resolves to a site or the maintenance page', async () => {
    const result = await visitor.resolveHost(env.LIVE_SITE_HOST!);
    expect(['placeholder', 'maintenance']).toContain(result.outcome);
  });
});
