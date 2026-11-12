'use client';
import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useActionState,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ActionState } from '@/app/actions/workspaces';

type ServerAction = (state: ActionState, form: FormData) => Promise<ActionState>;

/** Fields whose values are never put back after a failed submission. */
const NEVER_RESTORE = new Set(['password', 'file', 'hidden']);

/**
 * A small form around one server action: hidden selector fields, the caller's inputs and buttons, and the
 * action's outcome below. The server re-authorizes every submission; hidden fields are selectors, not proof.
 *
 * Acceptance run 2 (P2 S10): after a failed submission the form keeps what the person typed (React resets a form
 * after its action), marks the fields the server named (`aria-invalid`) and moves focus to the first one; a
 * destructive action asks in an in-page dialog instead of the browser's `confirm()`; a returned link has a Copy button.
 */
export function ActionForm({
  action,
  hidden,
  children,
  confirm,
  confirmLabel = 'Confirm',
  className = 'flex flex-wrap items-center gap-2',
}: {
  action: ServerAction;
  hidden: Record<string, string>;
  children: ReactNode;
  /** Asks before submitting (destructive actions). */
  confirm?: string;
  confirmLabel?: string;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});
  const formRef = useRef<HTMLFormElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submitted = useRef<[string, string][]>([]);
  const confirmed = useRef(false);

  useEffect(() => {
    const form = formRef.current;
    if (!form || !state.error) return;
    for (const [name, value] of submitted.current) {
      const el = form.elements.namedItem(name);
      if (
        (el instanceof HTMLInputElement && !NEVER_RESTORE.has(el.type)) ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement
      ) {
        el.value = value;
      }
    }
    const invalid = Object.keys(state.fieldErrors ?? {}).map((k) => k.split('.').at(-1) ?? k);
    let first: HTMLElement | null = null;
    for (const el of Array.from(form.elements)) {
      if (!(
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement
      ))
        continue;
      const bad = invalid.includes(el.name);
      if (bad) el.setAttribute('aria-invalid', 'true');
      else el.removeAttribute('aria-invalid');
      if (bad && !first) first = el;
    }
    first?.focus();
  }, [state]);

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={(event) => {
        if (confirm && !confirmed.current) {
          event.preventDefault();
          dialogRef.current?.showModal();
          return;
        }
        confirmed.current = false;
        submitted.current = Array.from(new FormData(event.currentTarget).entries()).flatMap(([k, v]) =>
          typeof v === 'string' ? [[k, v] as [string, string]] : [],
        );
      }}
      aria-busy={pending}
    >
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div className={className}>{children}</div>
      {confirm ? (
        <dialog
          ref={dialogRef}
          className="w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-slate-200 p-0 shadow-xl backdrop:bg-slate-900/40"
        >
          <div className="space-y-4 p-5">
            <p className="text-sm text-slate-800">{confirm}</p>
            <div className="flex justify-end gap-2">
              <SmallButton type="button" onClick={() => dialogRef.current?.close()} autoFocus>
                Cancel
              </SmallButton>
              <SmallButton
                type="button"
                variant="danger"
                onClick={() => {
                  dialogRef.current?.close();
                  confirmed.current = true;
                  formRef.current?.requestSubmit();
                }}
              >
                {confirmLabel}
              </SmallButton>
            </div>
          </div>
        </dialog>
      ) : null}
      {state.error ? (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {state.error}
          {Object.values(state.fieldErrors ?? {}).length
            ? ` ${Object.values(state.fieldErrors ?? {}).join(' ')}`
            : ''}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="mt-1 text-xs text-emerald-700">
          {state.ok}
        </p>
      ) : null}
      {state.link ? <CopyLink link={state.link} label={state.linkLabel} note={state.linkNote} /> : null}
    </form>
  );
}

/** A read-only link with a Copy button (the browser clipboard; falls back to selecting the text). */
export function CopyLink({
  link,
  label,
  note,
}: {
  link: string;
  label?: string | undefined;
  note?: string | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="mt-2 space-y-1">
      <div className="flex gap-2">
        <input
          ref={input}
          readOnly
          aria-label={label ?? 'Invitation link'}
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="block w-full min-w-0 rounded-md border border-slate-300 bg-slate-50 px-2 py-1 font-mono text-xs"
        />
        <SmallButton
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopied(true);
              setTimeout(() => setCopied(false), 2500);
            } catch {
              input.current?.select();
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </SmallButton>
      </div>
      <p className="text-xs text-slate-500" aria-live="polite">
        {copied ? 'Link copied. ' : ''}
        {note ?? 'Share it only with the invited person. It works once.'}
      </p>
    </div>
  );
}

export function SmallButton({
  children,
  variant = 'secondary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'secondary' | 'danger' | 'primary' }) {
  const styles = {
    primary: 'bg-[var(--color-primary)] text-white hover:opacity-90',
    secondary: 'border border-slate-300 bg-white text-slate-900 hover:bg-slate-50',
    danger: 'border border-red-200 bg-white text-red-700 hover:bg-red-50',
  }[variant];
  return (
    <button
      className={`rounded-md px-2.5 py-1.5 text-xs font-medium disabled:opacity-50 ${styles}`}
      {...props}
    >
      {children}
    </button>
  );
}
