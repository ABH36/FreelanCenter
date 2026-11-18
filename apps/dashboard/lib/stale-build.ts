/**
 * P3 S9a (DG-39 (b)): version skew. A page loaded before a deployment still holds the old build's server action
 * ids; after the deployment the server no longer knows them and the call throws `UnrecognizedActionError`
 * (seen 12 times in the S8c production check). Nothing is saved by such a call, so the person must be told and
 * asked to reload: the `StaleBuildGuard` in the root layout shows that, whichever page made the call.
 *
 * Callers with their own status line (the editor's "Saving…") catch the error themselves and announce it; any
 * other call that throws it reaches the guard as an unhandled rejection or through the root error boundary.
 * No cost: Vercel Skew Protection (paid) was not chosen (Owner, 2026-11-18).
 */
import { unstable_isUnrecognizedActionError } from 'next/navigation';

export const STALE_BUILD_EVENT = 'platform:stale-build';

export const STALE_BUILD_TITLE = 'A new version of the dashboard is available';
export const STALE_BUILD_MESSAGE =
  'Reload to keep editing. Your last change may not have been saved: check it after the reload.';

export function isStaleBuildError(error: unknown): boolean {
  return unstable_isUnrecognizedActionError(error);
}

/** Tells the guard to show the reload notice. Safe to call more than once. */
export function announceStaleBuild(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(STALE_BUILD_EVENT));
}

/**
 * Runs a server action call. When it fails because the build changed, the guard is told and `onStale` runs
 * (for the caller's own status line); the error is then rethrown so no caller mistakes it for success.
 */
export async function guardAction<T>(run: () => Promise<T>, onStale?: () => void): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isStaleBuildError(error)) {
      announceStaleBuild();
      onStale?.();
    }
    throw error;
  }
}
