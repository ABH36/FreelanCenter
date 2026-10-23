import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getSession } from '@/lib/auth';
import { rememberInviteAction } from '@/app/actions/workspaces';
import { AuthCard, Button } from '@/components/ui';
import { requireUserId, workspaces } from '@/lib/workspaces';
import { AcceptInvitation } from './accept-invitation';

export const metadata: Metadata = { title: 'Invitation' };

/**
 * FR-AUTH-06. The token in the path is the credential (SEC-11: `Referrer-Policy: no-referrer` on this route,
 * next.config.ts). Signed out: the token is kept in an httpOnly cookie across sign-in or sign-up, never in a
 * query string. Signed in: a preview (workspace, role, masked address), then accept-once on the server.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await getSession();

  if (!session?.user?.emailVerified) {
    return (
      <Shell>
        <AuthCard
          title="You have been invited"
          subtitle="Sign in or create an account with the invited e-mail address to see and accept this invitation."
        >
          <div className="space-y-3">
            <form action={rememberInviteAction}>
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="next" value="sign-in" />
              <Button type="submit">Sign in to continue</Button>
            </form>
            <form action={rememberInviteAction}>
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="next" value="sign-up" />
              <Button type="submit" variant="secondary">
                Create an account
              </Button>
            </form>
          </div>
        </AuthCard>
      </Shell>
    );
  }

  const preview = await (await workspaces()).previewInvitation(await requireUserId(), token);
  if (!preview) {
    return (
      <Shell>
        <AuthCard
          title="Invitation not available"
          subtitle="This invitation is invalid, has expired, was revoked or has already been used. Ask the person who invited you for a new one."
        >
          <a href="/" className="text-sm font-medium text-[var(--color-primary)] hover:underline">
            Go to your dashboard
          </a>
        </AuthCard>
      </Shell>
    );
  }
  return (
    <Shell>
      <AuthCard
        title={`Join ${preview.workspaceName}`}
        subtitle={
          <>
            You are invited as <span className="font-medium">{preview.role}</span>. The invitation was sent to{' '}
            <span className="font-mono">{preview.emailHint}</span>; you are signed in as{' '}
            <span className="font-mono">{session.user.email}</span>.
          </>
        }
      >
        <AcceptInvitation token={token} />
      </AuthCard>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-[var(--color-surface)] px-4 py-12">
      {children}
    </main>
  );
}
