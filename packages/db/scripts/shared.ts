/** Helpers for the @platform/db Node scripts. */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDotEnv, type DbTarget } from '../src/env.ts';

export { connectionConfig } from '../src/connection.ts';

export const REPO_ENV_FILE = fileURLToPath(new URL('../../../.env.local', import.meta.url));

export function parseTarget(argv: string[]): DbTarget {
  const index = argv.indexOf('--target');
  const value = index === -1 ? 'local' : argv[index + 1];
  if (value !== 'local' && value !== 'env') throw new Error('--target must be "local" or "env"');
  return value;
}

/** For `env`, process variables win over the repository `.env.local` (CI injects secrets as variables). */
export function loadEnvironment(target: DbTarget): Record<string, string | undefined> {
  if (target === 'local') return { ...process.env };
  const fromFile = existsSync(REPO_ENV_FILE) ? parseDotEnv(readFileSync(REPO_ENV_FILE, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}
