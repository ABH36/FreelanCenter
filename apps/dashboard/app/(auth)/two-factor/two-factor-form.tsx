'use client';
import { useState, type FormEvent } from 'react';
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { Alert, AuthCard, Button, Field, TextLink } from '@/components/ui';

/**
 * Second step of a sign-in for TOTP users (FR-AUTH-03): after a password sign-in, after Google and after the
 * e-mail-verification link (DG-22). Locks after 5 wrong codes for 15 min.
 */
export function TwoFactorForm() {
  const [mode, setMode] = useState<'totp' | 'backup'>('totp');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code')).replace(/\s+/g, '');
    const trustDevice = false;
    setPending(true);
    setError('');
    const { error } =
      mode === 'totp'
        ? await authClient.twoFactor.verifyTotp({ code, trustDevice })
        : await authClient.twoFactor.verifyBackupCode({ code, trustDevice });
    if (error) {
      setPending(false);
      return setError(authErrorMessage(error));
    }
    window.location.assign(returnTarget());
  }

  return (
    <AuthCard
      title="Two-factor authentication"
      subtitle={
        mode === 'totp'
          ? 'Enter the 6-digit code from your authenticator app.'
          : 'Enter one of the backup codes you saved when you turned on two-factor authentication.'
      }
      footer={<TextLink href="/sign-in">Start again</TextLink>}
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Alert>{error}</Alert>
        {mode === 'totp' ? (
          <Field
            key="totp"
            id="code"
            label="Authentication code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
          />
        ) : (
          <Field key="backup" id="code" label="Backup code" autoComplete="off" required autoFocus />
        )}
        <Button type="submit" disabled={pending}>
          {pending ? 'Verifying…' : 'Verify'}
        </Button>
        <button
          type="button"
          className="w-full text-center text-sm text-slate-600 hover:underline"
          onClick={() => {
            setError('');
            setMode(mode === 'totp' ? 'backup' : 'totp');
          }}
        >
          {mode === 'totp' ? 'Use a backup code instead' : 'Use your authenticator app'}
        </button>
      </form>
    </AuthCard>
  );
}

/** Where to go after the code: the server puts a same-origin path in `callbackURL`; anything else means home. */
function returnTarget(): string {
  const target = new URLSearchParams(window.location.search).get('callbackURL');
  return target && /^\/(?![/\\])/.test(target) ? target : '/';
}
