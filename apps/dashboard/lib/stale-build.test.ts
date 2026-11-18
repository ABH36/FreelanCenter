import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STALE_BUILD_EVENT, guardAction, isStaleBuildError } from './stale-build';

// P3 S9a (DG-39 (b)): a server action from an older build is reported, never mistaken for success.
describe('stale build detection', () => {
  afterEach(() => vi.unstubAllGlobals());

  const listen = () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const seen = vi.fn();
    target.addEventListener(STALE_BUILD_EVENT, seen);
    return seen;
  };

  it('recognizes the error Next throws for an unknown server action', () => {
    expect(isStaleBuildError(new UnrecognizedActionError('Server Action "x" was not found'))).toBe(true);
    expect(isStaleBuildError(new Error('network'))).toBe(false);
    expect(isStaleBuildError('nope')).toBe(false);
  });

  it('announces a stale build, tells the caller, and still rejects', async () => {
    const seen = listen();
    const onStale = vi.fn();
    const call = guardAction(() => Promise.reject(new UnrecognizedActionError('gone')), onStale);
    await expect(call).rejects.toBeInstanceOf(UnrecognizedActionError);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('passes other failures through without the reload notice', async () => {
    const seen = listen();
    const onStale = vi.fn();
    await expect(guardAction(() => Promise.reject(new Error('offline')), onStale)).rejects.toThrow('offline');
    expect(seen).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
  });

  it('returns the result of a call that works', async () => {
    listen();
    await expect(guardAction(() => Promise.resolve({ ok: true }))).resolves.toEqual({ ok: true });
  });
});
