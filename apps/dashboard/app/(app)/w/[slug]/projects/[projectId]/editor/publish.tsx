'use client';
/**
 * P3 S7a: the Publish panel of the editor (FR-PUB-01, FR-PUB-02, FR-PUB-04; module 06; approved 2026-11-15).
 *
 *   - Where it goes: Staging (a review copy, shared by link) or Live (the public website). Editors publish to
 *     staging only; owners and admins also to live (decision 4). The server re-checks every call.
 *   - Checks: the same preflight the server runs on publish, for the chosen target. Blocking checks disable the
 *     button and say what to fix; warnings are listed and do not stop publishing.
 *   - Publishing first saves any change still waiting, then publishes exactly that revision with a fresh publish
 *     key (a retried request publishes once).
 *   - Review links: 14-day links to the current staging version, copied or turned off here.
 *   - The live address is shown with a note: it opens only once the sites domain exists (DG-11, DG-33).
 */
import { useCallback, useEffect, useState } from 'react';
import type { PreflightCheck } from '@platform/workspaces';
import {
  type ClientPublishingStatus,
  createStagingLinkAction,
  preflightAction,
  publishAction,
  publishingStatusAction,
  revokeStagingLinkAction,
} from '@/app/actions/publishing';

type Kind = 'staging' | 'live';

export interface PublishPanelProps {
  target: { workspaceId: string; projectId: string };
  /** Saves any pending change and returns the draft revision the editor now holds. */
  prepare: () => Promise<number>;
  canPublishStaging: boolean;
  canPublishLive: boolean;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

function VersionLine({ label, v }: { label: string; v: ClientPublishingStatus['live'] }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
      <dt className="font-medium">{label}</dt>
      <dd className="text-slate-700" data-testid={`publish-${label.toLowerCase()}`}>
        {v
          ? `Version ${v.number ?? '?'} · ${when(v.publishedAt)}${v.publishedByName ? ` · ${v.publishedByName}` : ''}`
          : 'Not published yet'}
      </dd>
    </div>
  );
}

function CheckList({ checks }: { checks: PreflightCheck[] }) {
  if (checks.length === 0) return <p className="text-sm text-emerald-800">All checks passed.</p>;
  return (
    <ul className="space-y-2" aria-label="Checks">
      {checks.map((c, i) => (
        <li
          key={`${c.rule}-${i}`}
          className={`rounded-md border px-3 py-2 text-sm ${
            c.level === 'blocking'
              ? 'border-red-200 bg-red-50 text-red-900'
              : 'border-amber-200 bg-amber-50 text-amber-900'
          }`}
        >
          <span className="font-semibold">{c.level === 'blocking' ? 'Must fix: ' : 'Check: '}</span>
          {c.where ? <span className="font-medium">{c.where}. </span> : null}
          {c.message}
        </li>
      ))}
    </ul>
  );
}

export function PublishPanel({ target, prepare, canPublishStaging, canPublishLive }: PublishPanelProps) {
  const [status, setStatus] = useState<ClientPublishingStatus | null>(null);
  const [kind, setKind] = useState<Kind>('staging');
  const [checks, setChecks] = useState<{ ok: boolean; checks: PreflightCheck[] } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(
    async (forKind: Kind) => {
      await prepare();
      const [s, p] = await Promise.all([
        publishingStatusAction(target),
        preflightAction({ ...target, kind: forKind }),
      ]);
      if (s.ok) setStatus(s.value);
      else setProblem(s.error);
      if (p.ok) setChecks({ ok: p.value.ok, checks: p.value.checks });
      else setProblem(p.error);
    },
    [target, prepare],
  );

  useEffect(() => {
    void refresh(kind);
  }, [refresh, kind]);

  const allowed = kind === 'live' ? canPublishLive : canPublishStaging;

  const publish = async () => {
    setBusy(true);
    setProblem('');
    setMessage('');
    const revision = await prepare();
    const result = await publishAction({
      ...target,
      kind,
      expectedRevision: revision,
      publishKey: crypto.randomUUID(),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setProblem(
        result.code === 'PREFLIGHT_BLOCKED'
          ? 'Fix the problems marked "Must fix" first.'
          : result.code === 'DRAFT_CONFLICT'
            ? 'The site changed while you were publishing. Check it and publish again.'
            : result.error,
      );
      await refresh(kind);
      return;
    }
    setNote('');
    setMessage(
      `Published version ${result.value.number ?? ''} to ${kind === 'live' ? 'Live' : 'Staging'}${
        result.value.warnings
          ? ` with ${result.value.warnings} check${result.value.warnings > 1 ? 's' : ''} to look at`
          : ''
      }.`,
    );
    await refresh(kind);
  };

  const createLink = async () => {
    setBusy(true);
    setProblem('');
    const result = await createStagingLinkAction(target);
    setBusy(false);
    if (!result.ok) return setProblem(result.error);
    setMessage('Review link created. Copy it and send it to your client.');
    await refresh(kind);
  };

  const revoke = async (linkId: string) => {
    setBusy(true);
    const result = await revokeStagingLinkAction({ workspaceId: target.workspaceId, linkId });
    setBusy(false);
    if (!result.ok) return setProblem(result.error);
    setMessage('The review link was turned off.');
    await refresh(kind);
  };

  const copy = async (url: string, id: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(id);
    } catch {
      setCopied(null);
    }
  };

  const host = status?.hosts[0];
  const local = host?.endsWith('.localhost');

  return (
    <div className="space-y-5">
      <dl className="space-y-1 rounded-md border border-slate-200 p-3">
        <VersionLine label="Live" v={status?.live ?? null} />
        <VersionLine label="Staging" v={status?.staging ?? null} />
        {host ? (
          <div className="pt-1 text-xs text-slate-700">
            Live address:{' '}
            {local ? (
              <a className="underline" href={`http://${host}:3001`} target="_blank" rel="noreferrer">
                {host}
              </a>
            ) : (
              <span className="font-mono">{host}</span>
            )}
            {local ? null : (
              <span className="block" data-testid="domain-note">
                The live address will work once the sites domain is set up.
              </span>
            )}
          </div>
        ) : null}
      </dl>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Publish to</legend>
        <div className="flex flex-wrap gap-2">
          {(['staging', 'live'] as const).map((k) => (
            <label
              key={k}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 px-3 py-1.5 text-sm has-[:checked]:border-slate-900 has-[:checked]:bg-slate-900 has-[:checked]:text-white"
            >
              <input
                type="radio"
                name="publish-kind"
                value={k}
                checked={kind === k}
                onChange={() => setKind(k)}
                className="sr-only"
              />
              {k === 'staging' ? 'Staging (review copy)' : 'Live (public website)'}
            </label>
          ))}
        </div>
        {kind === 'live' && !canPublishLive ? (
          <p className="text-sm text-slate-700">Only owners and admins can publish to Live.</p>
        ) : null}
      </fieldset>

      <section aria-labelledby="checks-title" className="space-y-2">
        <h3 id="checks-title" className="text-sm font-semibold">
          Checks before publishing to {kind === 'live' ? 'Live' : 'Staging'}
        </h3>
        {checks ? <CheckList checks={checks.checks} /> : <p className="text-sm text-slate-600">Checking…</p>}
      </section>

      <div className="space-y-2">
        <label className="block text-sm font-medium" htmlFor="publish-note">
          Note for the history (optional)
        </label>
        <input
          id="publish-note"
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          placeholder="For example: new prices for December"
          className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={() => void publish()}
          disabled={!allowed || busy || !checks || !checks.ok}
          className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Publishing…' : kind === 'live' ? 'Publish to Live' : 'Publish to Staging'}
        </button>
      </div>

      {message ? (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          {message}
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {problem}
        </p>
      ) : null}

      <section aria-labelledby="links-title" className="space-y-2 border-t border-slate-200 pt-4">
        <h3 id="links-title" className="text-sm font-semibold">
          Review links
        </h3>
        <p className="text-sm text-slate-700">
          Send your client a link to the staging version. It needs no account, lasts 14 days, is hidden from
          search engines, and always shows the latest staging version.
        </p>
        {status && !status.stagingLinksConfigured ? (
          <p className="text-sm text-slate-700">Review links are not set up in this environment yet.</p>
        ) : (
          <>
            <ul className="space-y-2">
              {(status?.stagingLinks ?? []).map((l) => (
                <li key={l.id} className="space-y-1 rounded-md border border-slate-200 p-2 text-sm">
                  <div className="text-xs text-slate-700">
                    Until {when(l.expiresAt)}
                    {l.createdByName ? ` · made by ${l.createdByName}` : ''}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void copy(l.url, l.id)}
                      className="rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-50"
                    >
                      {copied === l.id ? 'Copied' : 'Copy link'}
                    </button>
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-50"
                    >
                      Open
                    </a>
                    {canPublishStaging ? (
                      <button
                        type="button"
                        onClick={() => void revoke(l.id)}
                        disabled={busy}
                        className="rounded-md border border-red-200 px-2 py-1 text-red-800 hover:bg-red-50"
                      >
                        Turn off
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            {canPublishStaging ? (
              <button
                type="button"
                onClick={() => void createLink()}
                disabled={busy || !status?.staging}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
              >
                Create review link
              </button>
            ) : null}
            {status && !status.staging ? (
              <p className="text-xs text-slate-700">Publish to Staging first; the link shows that version.</p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
