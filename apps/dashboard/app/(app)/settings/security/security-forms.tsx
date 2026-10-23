'use client';
import { useState, type FormEvent } from 'react';
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { Alert, Button, Field, Panel, TextLink } from '@/components/ui';
import { QrCode } from '@/components/qr-code';

type Enrolment = { totpURI: string; backupCodes: string[] };

function secretOf(uri: string): string {
  return new URL(uri).searchParams.get('secret') ?? '';
}

/** FR-AUTH-03: TOTP enrolment (password, scan, confirm with a code), backup codes, disable. */
export function TwoFactorSettings({ enabled, hasPassword }: { enabled: boolean; hasPassword: boolean }) {
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password'));
    setPending(true);
    setError('');
    const { data, error } = await authClient.twoFactor.enable({ password });
    setPending(false);
    if (error || !data || data.method !== 'totp') return setError(authErrorMessage(error));
    setEnrolment({ totpURI: data.totpURI, backupCodes: data.backupCodes });
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code')).replace(/\s+/g, '');
    setPending(true);
    setError('');
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (error) return setError(authErrorMessage(error));
    window.location.reload();
  }

  async function disable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password'));
    setPending(true);
    setError('');
    const { error } = await authClient.twoFactor.disable({ password });
    setPending(false);
    if (error) return setError(authErrorMessage(error));
    window.location.reload();
  }

  async function regenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password'));
    setPending(true);
    setError('');
    const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
    setPending(false);
    if (error || !data) return setError(authErrorMessage(error));
    setCodes(data.backupCodes);
  }

  const status = (
    <span
      className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${
        enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'
      }`}
    >
      {enabled ? 'On' : 'Off'}
    </span>
  );

  return (
    <Panel
      title="Two-factor authentication"
      description={
        <>
          An authenticator app code is required at every sign-in. Required for owners before payouts or
          white-label can be enabled. {status}
        </>
      }
    >
      <div className="space-y-4">
        <Alert>{error}</Alert>
        {!hasPassword && !enabled ? (
          <Alert tone="info">
            Two-factor authentication needs an account password. Signed up with Google?{' '}
            <TextLink href="/forgot-password">Set a password</TextLink> first.
          </Alert>
        ) : null}

        {!enabled && hasPassword && !enrolment ? (
          <form onSubmit={start} className="max-w-sm space-y-3">
            <Field
              id="password"
              label="Confirm your password"
              type="password"
              autoComplete="current-password"
              required
            />
            <Button type="submit" disabled={pending} className="sm:w-auto">
              Set up two-factor authentication
            </Button>
          </form>
        ) : null}

        {enrolment ? (
          <div className="space-y-5">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
              <li>Scan the QR code with an authenticator app, or enter the key manually.</li>
              <li>Save the backup codes somewhere safe. Each works once.</li>
              <li>Enter the 6-digit code from the app to finish.</li>
            </ol>
            <div className="flex flex-col gap-5 sm:flex-row">
              <QrCode value={enrolment.totpURI} label="Authenticator QR code" />
              <div className="min-w-0 space-y-3 text-sm">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Setup key</div>
                  <code className="mt-1 block break-all rounded bg-slate-100 px-2 py-1 font-mono text-xs">
                    {secretOf(enrolment.totpURI)}
                  </code>
                </div>
                <BackupCodes codes={enrolment.backupCodes} />
              </div>
            </div>
            <form onSubmit={confirm} className="max-w-sm space-y-3">
              <Field
                id="code"
                label="Authentication code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
              />
              <Button type="submit" disabled={pending} className="sm:w-auto">
                Turn on
              </Button>
            </form>
          </div>
        ) : null}

        {enabled ? (
          <div className="grid gap-6 md:grid-cols-2">
            <form onSubmit={regenerate} className="space-y-3">
              <h3 className="text-sm font-medium">New backup codes</h3>
              <Field
                id="regen-password"
                label="Password"
                type="password"
                autoComplete="current-password"
                required
              />
              <Button type="submit" variant="secondary" disabled={pending}>
                Generate new codes
              </Button>
              {codes ? <BackupCodes codes={codes} /> : null}
            </form>
            <form onSubmit={disable} className="space-y-3">
              <h3 className="text-sm font-medium">Turn off</h3>
              <Field
                id="disable-password"
                label="Password"
                type="password"
                autoComplete="current-password"
                required
              />
              <Button type="submit" variant="danger" disabled={pending}>
                Turn off two-factor authentication
              </Button>
            </form>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
        Backup codes (shown once)
      </div>
      <ul className="mt-1 grid grid-cols-2 gap-1 font-mono text-xs">
        {codes.map((c) => (
          <li key={c} className="rounded bg-slate-100 px-2 py-1">
            {c}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="mt-2 text-xs font-medium text-[var(--color-primary)] hover:underline"
        onClick={() => void navigator.clipboard.writeText(codes.join('\n'))}
      >
        Copy codes
      </button>
    </div>
  );
}

export function ChangePassword() {
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const newPassword = String(form.get('new-password'));
    if (newPassword !== String(form.get('confirm-password'))) {
      return setMessage({ tone: 'error', text: 'The new passwords do not match.' });
    }
    setPending(true);
    const { error } = await authClient.changePassword({
      currentPassword: String(form.get('current-password')),
      newPassword,
      revokeOtherSessions: true,
    });
    setPending(false);
    if (error) return setMessage({ tone: 'error', text: authErrorMessage(error) });
    formEl.reset();
    setMessage({ tone: 'success', text: 'Password changed. Other devices have been signed out.' });
  }

  return (
    <Panel title="Password" description="Changing your password signs out every other device.">
      <form onSubmit={onSubmit} className="max-w-sm space-y-3">
        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
        <Field
          id="current-password"
          label="Current password"
          type="password"
          autoComplete="current-password"
          required
        />
        <Field
          id="new-password"
          label="New password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          hint="At least 12 characters."
          required
        />
        <Field
          id="confirm-password"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          required
        />
        <Button type="submit" disabled={pending} className="sm:w-auto">
          Change password
        </Button>
      </form>
    </Panel>
  );
}

/** FR-AUTH-02 "log out all devices", including this one. */
export function SignOutEverywhere() {
  const [pending, setPending] = useState(false);
  return (
    <Panel title="Sessions" description="Sign out of every browser and device, including this one.">
      <Button
        type="button"
        variant="secondary"
        disabled={pending}
        className="sm:w-auto"
        onClick={async () => {
          setPending(true);
          await authClient.revokeSessions();
          window.location.assign('/sign-in');
        }}
      >
        Log out all devices
      </Button>
    </Panel>
  );
}
