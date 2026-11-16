'use client';
/**
 * P3 S7b: the two actions of a history row. Both ask once more before acting, like turning off a review link:
 *   - Rollback (owners, admins): Live shows this earlier live version again; the draft is not touched.
 *   - Restore into the draft (owners, admins, editors): the editor gets this version's content as one change that
 *     Undo reverses; Live and Staging are not touched.
 * Each click carries a fresh UUID (retry-safe) and the state the page showed (expected live version / draft
 * revision), so a page that is out of date is refused instead of overwriting newer work.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { restoreVersionAction, rollbackAction } from '@/app/actions/publishing';

type Target = { workspaceId: string; projectId: string };

const vName = (n: number | null) => `version ${n ?? '?'}`;

function Confirm({
  label,
  text,
  confirm,
  onConfirm,
  busy,
  tone,
}: {
  label: string;
  text: string;
  confirm: string;
  onConfirm: () => void;
  busy: boolean;
  tone: 'danger' | 'normal';
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        onClick={() => setAsking(true)}
        disabled={busy}
        className={`rounded-md border px-2 py-1 disabled:opacity-50 ${
          tone === 'danger'
            ? 'border-red-200 text-red-800 hover:bg-red-50'
            : 'border-slate-300 hover:bg-slate-50'
        }`}
      >
        {label}
      </button>
    );
  }
  return (
    <div
      role="group"
      aria-label={`Confirm: ${label}`}
      className="flex w-full flex-wrap items-center gap-2 rounded-md bg-amber-50 p-2 text-sm text-amber-950"
    >
      <span>{text}</span>
      <button
        type="button"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
        disabled={busy}
        className="rounded-md bg-slate-900 px-2 py-1 font-medium text-white hover:bg-slate-800"
      >
        {confirm}
      </button>
      <button
        type="button"
        onClick={() => setAsking(false)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-800 hover:bg-slate-50"
      >
        Cancel
      </button>
    </div>
  );
}

function Outcome({ message, problem }: { message: string; problem: string }) {
  return (
    <>
      {message ? (
        <p role="status" className="w-full rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          {message}
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="w-full rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {problem}
        </p>
      ) : null}
    </>
  );
}

export function RollbackButton({
  target,
  versionId,
  versionNumber,
  expectedLiveVersionId,
  liveNumber,
}: {
  target: Target;
  versionId: string;
  versionNumber: number | null;
  expectedLiveVersionId: string;
  liveNumber: number | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');
  const run = async () => {
    setBusy(true);
    setProblem('');
    const result = await rollbackAction({ ...target, versionId, expectedLiveVersionId });
    setBusy(false);
    if (!result.ok) {
      setProblem(result.error);
      if (result.code === 'LIVE_CHANGED') router.refresh();
      return;
    }
    // The row's own button disappears once this version is on Live, so the page says it (extension check
    // 2026-11-16: the message was lost with the button).
    setMessage(`Live now shows ${vName(result.value.number)} again.`);
    router.replace(`${window.location.pathname}?rolledBack=${result.value.number ?? ''}`);
  };
  return (
    <>
      <Confirm
        label="Put back on Live"
        text={`Make ${vName(versionNumber)} the live website again? Live shows ${
          liveNumber ? vName(liveNumber) : 'another version'
        } now. Your draft does not change, and you can switch back from this list.`}
        confirm={`Put ${vName(versionNumber)} on Live`}
        onConfirm={() => void run()}
        busy={busy}
        tone="danger"
      />
      <Outcome message={message} problem={problem} />
    </>
  );
}

export function RestoreButton({
  target,
  slug,
  versionId,
  versionNumber,
  expectedRevision,
}: {
  target: Target;
  slug: string;
  versionId: string;
  versionNumber: number | null;
  expectedRevision: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const run = async () => {
    setBusy(true);
    setProblem('');
    const result = await restoreVersionAction({
      ...target,
      versionId,
      expectedRevision,
      changeId: crypto.randomUUID(),
    });
    setBusy(false);
    if (!result.ok) {
      setProblem(
        result.code === 'DRAFT_CONFLICT'
          ? 'The draft changed since this page was opened. The page was refreshed; try again.'
          : result.error,
      );
      if (result.code === 'DRAFT_CONFLICT') router.refresh();
      return;
    }
    router.push(`/w/${slug}/projects/${target.projectId}/editor`);
  };
  return (
    <>
      <Confirm
        label="Restore into the editor"
        text={`Replace the editor's current draft with ${vName(versionNumber)}? Undo in the editor brings the current draft back. Live and Staging do not change.`}
        confirm={`Restore ${vName(versionNumber)}`}
        onConfirm={() => void run()}
        busy={busy}
        tone="normal"
      />
      <Outcome message="" problem={problem} />
    </>
  );
}
