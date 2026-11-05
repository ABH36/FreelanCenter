// Bundles the quality harness (real serveHost + the three built-in templates) into one file for plain `node`.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/serve.ts'],
  outfile: '.cache/serve.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  alias: { 'server-only': './src/empty.ts' },
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
