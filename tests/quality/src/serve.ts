import process from 'node:process';
/**
 * Quality harness: the real `serveHost` (apps/sites) over HTTP, with a fake resolver and one site per built-in
 * template at `<slug>.quality.localhost`. Fonts come from the sites app's public folder, exactly as in production.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registry } from '@platform/blocks';
import { createHostResolver } from '@platform/hosting';
import { createMemoryStore } from '@platform/providers';
import { serveHost } from '../../../apps/sites/lib/serve';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, here.endsWith('.cache') ? '..' : '..');
const seed = JSON.parse(
  readFileSync(resolve(root, '../../packages/templates/seed/builtin-templates.json'), 'utf8'),
) as { templates: { slug: string; config: unknown }[] };
const fonts = resolve(root, '../../apps/sites/public/fonts');
const PORT = Number(process.env.QUALITY_PORT ?? 4010);

type Config = { business: Record<string, unknown>; pages: Record<string, unknown>[] };

/**
 * Every block variant in the registry on one extra page (`/all-blocks`), so axe and the screenshots cover all of them under
 * each template's theme, not just the variants the three templates happen to use. `<slug>-hi` is the same site in Hindi.
 */
function withGallery(config: Config, language: 'en' | 'hi'): Config {
  const sections = registry.list().flatMap((def) =>
    def.variants.map((v) => ({
      id: `${def.type}-${v.id}`,
      type: def.type,
      variant: v.id,
      visible: true,
      props: def.defaults(v.id),
    })),
  );
  return {
    ...config,
    business: { ...config.business, language },
    pages: [...config.pages, { id: 'all-blocks', path: '/all-blocks', title: 'All blocks', sections }],
  };
}

const bySlug = new Map<string, unknown>();
for (const t of seed.templates) {
  bySlug.set(t.slug, withGallery(structuredClone(t.config) as Config, 'en'));
  bySlug.set(`${t.slug}-hi`, withGallery(structuredClone(t.config) as Config, 'hi'));
}
const resolver = createHostResolver({
  cache: createMemoryStore(),
  lookup: async () => ({ outcome: 'placeholder', workspaceId: 'w', projectId: 'p' }),
});
const log = (m: string, d?: unknown) =>
  process.env.QUALITY_DEBUG &&
  process.stderr.write(`${m} ${JSON.stringify(d)}
`);
const logger = { debug() {}, info() {}, warn: log, error: log, fatal: log } as never;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/healthz') return void res.writeHead(200).end('ok');
  if (url.pathname.startsWith('/fonts/')) {
    const file = join(fonts, url.pathname.slice(7).replace(/[^a-z0-9._-]/gi, ''));
    if (!existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, {
      'content-type': 'font/woff2',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    return void res.end(readFileSync(file));
  }
  const host = (req.headers.host ?? '').toLowerCase();
  const slug = host.split('.')[0] ?? '';
  const config = bySlug.get(slug);
  const source = { load: async () => (config ? { config } : null) };
  const out = await serveHost(new Request(`http://internal${url.pathname}`, { headers: { host } }), {
    resolver: async () => resolver,
    logger,
    source,
  });
  const headers: Record<string, string> = {};
  out.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(out.status, headers);
  res.end(Buffer.from(await out.arrayBuffer()));
});
server.listen(PORT, '127.0.0.1', () =>
  process.stdout.write(`quality server on ${PORT}: ${[...bySlug.keys()].join(', ')}
`),
);
