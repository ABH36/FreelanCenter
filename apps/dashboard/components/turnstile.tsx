'use client';
/**
 * Cloudflare Turnstile widget (SEC-09). Explicit rendering, so the token is reset after every submit: a token is
 * single-use at Cloudflare's siteverify. Development and CI use Cloudflare's always-pass test site key.
 *
 * The widget says what is happening (loading, waiting for the check, failed with a Retry button), so a disabled
 * submit button is never unexplained, and a failure never reloads the page or clears what the person typed.
 */
import Script from 'next/script';
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export interface TurnstileHandle {
  reset(): void;
}

export function Turnstile({
  siteKey,
  onToken,
  action,
  ref,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
  action: string;
  ref?: Ref<TurnstileHandle>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'solved' | 'error'>('loading');

  const render = useCallback(() => {
    if (!window.turnstile || !container.current || widgetId.current) return;
    widgetId.current = window.turnstile.render(container.current, {
      sitekey: siteKey,
      action,
      theme: 'light',
      size: 'flexible',
      callback: (token: string) => {
        setStatus('solved');
        onToken(token);
      },
      'expired-callback': () => {
        setStatus('ready');
        onToken(null);
      },
      'error-callback': () => {
        setStatus('error');
        onToken(null);
      },
    });
    setStatus('ready');
  }, [siteKey, action, onToken]);

  useEffect(() => {
    if (loaded || window.turnstile) render();
    return () => {
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [loaded, render]);

  const reset = useCallback(() => {
    onToken(null);
    if (widgetId.current && window.turnstile) {
      window.turnstile.reset(widgetId.current);
      setStatus('ready');
    } else {
      setStatus('loading');
      render();
    }
  }, [onToken, render]);

  useImperativeHandle(ref, () => ({ reset }));

  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onReady={() => setLoaded(true)}
        onError={() => setStatus('error')}
      />
      <div ref={container} className="min-h-[65px]" data-testid="turnstile" />
      <p role="status" className="min-h-4 text-xs text-slate-600" data-testid="turnstile-status">
        {status === 'loading' ? 'Loading the security check…' : null}
        {status === 'ready' ? 'Complete the security check above to continue.' : null}
        {status === 'error' ? (
          <>
            Couldn’t load the security check. Your details are kept.{' '}
            <button type="button" onClick={reset} className="font-medium text-slate-900 underline">
              Retry
            </button>
          </>
        ) : null}
      </p>
    </>
  );
}
