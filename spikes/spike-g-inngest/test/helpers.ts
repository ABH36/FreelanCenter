import { randomUUID } from 'node:crypto';

export async function waitFor<T>(
  what: string,
  fn: () => T | undefined | false,
  timeoutMs = 90_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const uuid = () => randomUUID();
