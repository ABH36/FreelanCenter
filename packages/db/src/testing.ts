/**
 * Test-only entry point (`@platform/db/testing`), shared by this package's integration tests and the
 * cross-cutting isolation suite in `tests/isolation`. Application code must never import it: it carries the
 * local Docker connection strings and assertion helpers, nothing a request path needs.
 */
export { LOCAL_DATABASE_URLS } from './env';

/** Every SQLSTATE found on an error from `pg` or Prisma (driver-adapter errors nest it under meta/cause). */
export function sqlStates(error: unknown, seen = new Set<unknown>()): string[] {
  if (!error || typeof error !== 'object' || seen.has(error)) return [];
  seen.add(error);
  const found: string[] = [];
  for (const key of Object.getOwnPropertyNames(error)) {
    const value = (error as Record<string, unknown>)[key];
    if (
      (key === 'code' || key === 'originalCode') &&
      typeof value === 'string' &&
      /^[0-9A-Z]{5}$/.test(value)
    ) {
      found.push(value);
    } else if (typeof value === 'string') {
      for (const m of value.matchAll(/\b(?:Code: `|code: |SQLSTATE )([0-9A-Z]{5})\b/g))
        found.push(m[1] as string);
    } else if (value && typeof value === 'object') {
      found.push(...sqlStates(value, seen));
    }
  }
  return found;
}

export async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const states = sqlStates(error);
    if (states.includes(code)) return;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`expected SQLSTATE ${code}, got [${states.join(', ')}]: ${message}`, { cause: error });
  }
  throw new Error(`expected SQLSTATE ${code}, but the statement succeeded`);
}
