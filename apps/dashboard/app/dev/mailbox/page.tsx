import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { authRuntime } from '@/lib/auth';

export const metadata: Metadata = { title: 'Dev mailbox' };
export const dynamic = 'force-dynamic';

/**
 * Local development only (ADR-012: development uses a capture inbox, never real sends). 404 in every production
 * build and whenever mail goes through a real provider.
 */
export default function DevMailboxPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  const { mailbox } = authRuntime();
  if (!mailbox) notFound();
  const messages = [...mailbox.sent].reverse();
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">Dev mailbox</h1>
      <p className="text-sm text-slate-600">Captured in memory by this dev server. Restarting clears it.</p>
      {messages.length === 0 ? <p className="text-sm">No mail yet.</p> : null}
      {messages.map((m, i) => {
        const link = /https?:\/\/\S+/.exec(m.text)?.[0];
        return (
          <article
            key={i}
            className="rounded-md border border-slate-200 bg-white p-4 text-sm"
            data-testid="mail"
          >
            <div className="font-medium">{m.subject}</div>
            <div className="text-slate-500">
              to <span data-testid="mail-to">{m.to}</span> · {m.kind}
            </div>
            {link ? (
              <a
                href={link}
                className="mt-2 block break-all text-[var(--color-primary)] underline"
                data-testid="mail-link"
              >
                {link}
              </a>
            ) : null}
          </article>
        );
      })}
    </main>
  );
}
