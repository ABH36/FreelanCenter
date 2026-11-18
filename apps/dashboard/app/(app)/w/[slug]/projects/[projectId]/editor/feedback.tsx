'use client';
/**
 * P3 S8a: the Client feedback panel of the editor (FR-PUB-05; plan approved by the Owner 2026-11-16).
 *
 *   - Approvals: who approved which staging version through a review link, and when.
 *   - Comments the client left on the review page, newest first, each with where it is pinned (page and section of
 *     the version they saw), the version, the client's name and e-mail, and the replies. "Open" shows the ones not
 *     marked done; "All" shows every comment.
 *   - Owners, admins and editors reply (the client sees the reply on the review page) and mark a comment done or open
 *     it again. Everyone can read. The server re-checks every call.
 *   - "Show in editor" opens the pinned section, when the draft still has it.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  type ClientFeedback,
  replyToCommentAction,
  resolveCommentAction,
  reviewFeedbackAction,
} from '@/app/actions/review';
import { formatIst } from '@platform/ui/time';

type Comment = ClientFeedback['comments'][number];

interface DraftShape {
  pages: Array<{ id: string; title: string; sections: Array<{ id: string; type: string }> }>;
}

export interface FeedbackPanelProps {
  target: { workspaceId: string; projectId: string };
  config: DraftShape;
  canReply: boolean;
  /** Opens a section of the draft in the editor. */
  onShowSection: (sectionId: string) => void;
  /** Tells the editor how many comments are open (for the menu). */
  onOpenCount?: (open: number) => void;
}

// P3 S9a (DG-39 (c)): the product clock (12-hour IST), whatever the browser's time zone.
const when = (iso: string) => formatIst(iso);

const humanize = (type: string) =>
  type === 'cta-banner' ? 'Call-to-action banner' : `${type.charAt(0).toUpperCase()}${type.slice(1)}`;

/** Where a comment is pinned, in the draft's words; says so when the draft no longer has that part. */
export function pinText(
  config: DraftShape,
  c: { pageId: string | null; sectionId: string | null },
): {
  label: string;
  sectionInDraft: boolean;
} {
  if (!c.pageId) return { label: 'Whole website', sectionInDraft: false };
  const page = config.pages.find((p) => p.id === c.pageId);
  if (!page) return { label: 'A page that was removed', sectionInDraft: false };
  if (!c.sectionId) return { label: `${page.title}: whole page`, sectionInDraft: false };
  const section = page.sections.find((s) => s.id === c.sectionId);
  return section
    ? { label: `${page.title} › ${humanize(section.type)}`, sectionInDraft: true }
    : { label: `${page.title} › a section that was removed`, sectionInDraft: false };
}

function CommentItem({
  comment,
  config,
  canReply,
  busy,
  onReply,
  onResolve,
  onShowSection,
}: {
  comment: Comment;
  config: DraftShape;
  canReply: boolean;
  busy: boolean;
  onReply: (id: string, body: string) => Promise<boolean>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
  onShowSection: (sectionId: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const pin = pinText(config, comment);
  const replyId = `reply-${comment.id}`;
  return (
    <li className="space-y-2 rounded-md border border-slate-200 p-3" data-testid="feedback-comment">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-slate-600">
        <span className="font-semibold text-slate-800">{pin.label}</span>
        <span>
          Version {comment.versionNumber ?? '?'} · {when(comment.createdAt)}
        </span>
      </div>
      <p className="text-sm">
        <span className="font-medium">{comment.authorName}</span>
        {comment.authorEmail ? (
          <>
            {' · '}
            <a className="text-blue-700 underline" href={`mailto:${comment.authorEmail}`}>
              {comment.authorEmail}
            </a>
          </>
        ) : null}
        {comment.resolvedAt ? (
          <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-900">
            Done{comment.resolvedByName ? ` · ${comment.resolvedByName}` : ''}
          </span>
        ) : null}
      </p>
      <p className="text-sm break-words whitespace-pre-wrap">{comment.body}</p>
      {comment.replies.length > 0 ? (
        <ul className="space-y-2 border-l-2 border-blue-300 pl-3" aria-label="Replies">
          {comment.replies.map((r) => (
            <li key={r.id} className="text-sm">
              <span className="text-xs text-slate-600">
                {r.authorName ?? 'A member'} · {when(r.createdAt)}
              </span>
              <p className="break-words whitespace-pre-wrap">{r.body}</p>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {pin.sectionInDraft && comment.sectionId ? (
          <button
            type="button"
            onClick={() => onShowSection(comment.sectionId!)}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-slate-50"
          >
            Show in editor
          </button>
        ) : null}
        {canReply ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void onResolve(comment.id, !comment.resolvedAt)}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
          >
            {comment.resolvedAt ? 'Open again' : 'Mark done'}
          </button>
        ) : null}
      </div>
      {canReply ? (
        <form
          className="space-y-1"
          onSubmit={(e) => {
            e.preventDefault();
            void onReply(comment.id, draft).then((ok) => {
              if (ok) setDraft('');
            });
          }}
        >
          <label htmlFor={replyId} className="block text-xs font-medium">
            Reply to {comment.authorName} (they see it on the review page)
          </label>
          <textarea
            id={replyId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={2000}
            rows={2}
            className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
          <button
            type="submit"
            disabled={busy || draft.trim() === ''}
            className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            Send reply
          </button>
        </form>
      ) : null}
    </li>
  );
}

export function FeedbackPanel({ target, config, canReply, onShowSection, onOpenCount }: FeedbackPanelProps) {
  const [feedback, setFeedback] = useState<ClientFeedback | null>(null);
  const [show, setShow] = useState<'open' | 'all'>('open');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const r = await reviewFeedbackAction(target);
    if (r.ok) {
      setFeedback(r.value);
      onOpenCount?.(r.value.open);
    } else setProblem(r.error);
  }, [target, onOpenCount]);

  useEffect(() => {
    void load();
  }, [load]);

  const reply = async (commentId: string, body: string) => {
    setBusy(true);
    setProblem('');
    const r = await replyToCommentAction({ workspaceId: target.workspaceId, commentId, body });
    setBusy(false);
    if (!r.ok) {
      setProblem(r.error);
      return false;
    }
    setMessage('Reply sent. The client sees it on the review page.');
    await load();
    return true;
  };

  const resolve = async (commentId: string, resolved: boolean) => {
    setBusy(true);
    setProblem('');
    const r = await resolveCommentAction({ workspaceId: target.workspaceId, commentId, resolved });
    setBusy(false);
    if (!r.ok) return setProblem(r.error);
    setMessage(resolved ? 'Marked done.' : 'Opened again.');
    await load();
  };

  if (!feedback) {
    return problem ? (
      <p role="alert" className="text-sm text-red-800">
        {problem}
      </p>
    ) : (
      <p className="text-sm text-slate-600">Loading feedback…</p>
    );
  }

  const listed = show === 'open' ? feedback.comments.filter((c) => !c.resolvedAt) : feedback.comments;
  return (
    <div className="space-y-4" data-testid="feedback-panel">
      <p className="text-sm text-slate-600">
        Your client comments and approves on the review link (Publish → Review links). Their comments show up
        here.
      </p>
      <section aria-labelledby="approvals-title" className="space-y-2">
        <h3 id="approvals-title" className="text-sm font-semibold">
          Approvals
        </h3>
        {feedback.approvals.length === 0 ? (
          <p className="text-sm text-slate-600">No approval yet.</p>
        ) : (
          <ul className="space-y-1" data-testid="feedback-approvals">
            {feedback.approvals.map((a) => (
              <li key={a.id} className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                <span className="font-medium">{a.approverName}</span> approved staging version{' '}
                {a.versionNumber ?? '?'} on {when(a.approvedAt)}
                {a.approverEmail ? ` · ${a.approverEmail}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="comments-title" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="comments-title" className="text-sm font-semibold">
            Comments ({feedback.open} open of {feedback.comments.length})
          </h3>
          <div role="group" aria-label="Which comments" className="flex gap-1">
            {(['open', 'all'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={show === v}
                onClick={() => setShow(v)}
                className="rounded-md border border-slate-300 px-2.5 py-1 text-xs capitalize aria-pressed:bg-slate-900 aria-pressed:text-white"
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <p aria-live="polite" className="text-sm text-emerald-800">
          {message}
        </p>
        {problem ? (
          <p role="alert" className="text-sm text-red-800">
            {problem}
          </p>
        ) : null}
        {listed.length === 0 ? (
          <p className="text-sm text-slate-600">
            {show === 'open' && feedback.comments.length > 0 ? 'Every comment is done.' : 'No comments yet.'}
          </p>
        ) : (
          <ul className="space-y-3">
            {listed.map((c) => (
              <CommentItem
                key={c.id}
                comment={c}
                config={config}
                canReply={canReply}
                busy={busy}
                onReply={reply}
                onResolve={resolve}
                onShowSection={onShowSection}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
