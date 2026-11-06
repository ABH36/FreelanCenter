import process from 'node:process';
/**
 * Quality harness: the real `serveHost` (apps/sites) over HTTP, with a fake resolver and one site per built-in
 * template at `<slug>.quality.localhost`. Fonts come from the sites app's public folder, exactly as in production.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const bySlug = new Map(seed.templates.map((t) => [t.slug, t.config]));
const resolver = createHostResolver({
  cache: createMemoryStore(),
  lookup: async () => ({ outcome: 'placeholder', workspaceId: 'w', projectId: 'p' }),
});
const logger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {} } as never;

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
