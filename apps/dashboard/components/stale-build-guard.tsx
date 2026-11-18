'use client';
/**
 * P3 S9a (DG-39 (b)): the reload notice after a deployment. It covers the page, so nobody keeps editing in a tab
 * whose saves no longer reach the server, and offers a reload. It appears when a caller announces a stale build
 * (`announceStaleBuild`) or when such an error goes unhandled anywhere on the page.
 */
import { useEffect, useState } from 'react';
import {
  STALE_BUILD_EVENT,
  STALE_BUILD_MESSAGE,
  STALE_BUILD_TITLE,
  isStaleBuildError,
} from '@/lib/stale-build';

export function StaleBuildNotice() {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="stale-build-title"
      aria-describedby="stale-build-message"
      data-testid="stale-build"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
    >
      <div className="w-full max-w-md space-y-3 rounded-[var(--radius-base)] bg-white p-5 shadow-lg">
        <h2 id="stale-build-title" className="text-base font-semibold text-slate-900">
          {STALE_BUILD_TITLE}
        </h2>
        <p id="stale-build-message" className="text-sm text-slate-700">
          {STALE_BUILD_MESSAGE}
        </p>
        <button
          type="button"
          autoFocus
          onClick={() => window.location.reload()}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

export function StaleBuildGuard() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const show = () => setStale(true);
    const onRejection = (event: PromiseRejectionEvent) => {
      if (!isStaleBuildError(event.reason)) return;
      event.preventDefault();
      show();
    };
    window.addEventListener(STALE_BUILD_EVENT, show);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener(STALE_BUILD_EVENT, show);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return stale ? <StaleBuildNotice /> : null;
}
