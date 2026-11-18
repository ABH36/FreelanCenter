'use client';
/**
 * The dashboard's error boundary (P3 S9a). A form action that fails because a deployment changed the build
 * (DG-39 (b)) asks for a reload; anything else gets a plain "try again" instead of the framework's bare page.
 * Server errors arrive without details (only a digest that matches the server log).
 */
import { useEffect } from 'react';
import { StaleBuildNotice } from '@/components/stale-build-guard';
import { isStaleBuildError } from '@/lib/stale-build';

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const stale = isStaleBuildError(error);
  useEffect(() => {
    if (!stale) console.error(error);
  }, [error, stale]);

  if (stale) return <StaleBuildNotice />;
  const digest = error instanceof Error && 'digest' in error ? String(error.digest) : null;
  return (
    <main className="mx-auto max-w-md space-y-3 p-6" data-testid="error-page">
      <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
      <p className="text-sm text-slate-700">
        The page could not finish. Try again; if it keeps happening, reload the page.
        {digest ? ` Reference: ${digest}.` : ''}
      </p>
      <button
        type="button"
        onClick={() => retry()}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        Try again
      </button>
    </main>
  );
}
