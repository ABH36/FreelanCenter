'use client';
import { useRef, useState } from 'react';
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { Alert, AuthCard, Button, TextLink } from '@/components/ui';
import { Turnstile, type TurnstileHandle } from '@/components/turnstile';

/** "Check your inbox" with a Turnstile-guarded resend (rate limited server-side as well). */
export function CheckInbox({ email, siteKey }: { email?: string; siteKey: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [address, setAddress] = useState(email ?? '');
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const captcha = useRef<TurnstileHandle>(null);

  async function resend() {
    if (!token || !address) return;
    setPending(true);
    const { error } = await authClient.sendVerificationEmail(
      { email: address, callbackURL: '/verified' },
      { headers: { 'x-captcha-response': token } },
    );
    captcha.current?.reset();
    setPending(false);
    setMessage(
      error
        ? { tone: 'error', text: authErrorMessage(error) }
        : { tone: 'success', text: 'If the address needs verifying, a new link is on its way.' },
    );
  }

  return (
    <AuthCard
      title="Check your inbox"
      subtitle={
        email ? (
          <>
            If <strong>{email}</strong> can be registered, we have sent a verification link. It expires in 1
            hour.
          </>
        ) : (
          'Enter your email to get a new verification link. Links expire after 1 hour.'
        )
      }
      footer={<TextLink href="/sign-in">Back to sign in</TextLink>}
    >
      <div className="space-y-4">
        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
        {email ? null : (
          <input
            aria-label="Email"
            type="email"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="block w-full rounded-[var(--radius-base)] border border-slate-300 px-3 py-2 text-sm"
            placeholder="you@example.com"
          />
        )}
        <Turnstile ref={captcha} siteKey={siteKey} action="resend-verification" onToken={setToken} />
        <Button type="button" variant="secondary" disabled={pending || !token || !address} onClick={resend}>
          {pending ? 'Sending…' : 'Resend verification email'}
        </Button>
      </div>
    </AuthCard>
  );
}
