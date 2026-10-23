'use client';
import { type ButtonHTMLAttributes, type ReactNode, useActionState } from 'react';
import type { ActionState } from '@/app/actions/workspaces';

type ServerAction = (state: ActionState, form: FormData) => Promise<ActionState>;

/**
 * A small form around one server action: hidden selector fields, the caller's inputs and buttons, and the
 * action's outcome below. The server re-authorizes every submission; hidden fields are selectors, not proof.
 */
export function ActionForm({
  action,
  hidden,
  children,
  confirm,
  className = 'flex flex-wrap items-center gap-2',
}: {
  action: ServerAction;
  hidden: Record<string, string>;
  children: ReactNode;
  /** Asks before submitting (destructive actions). */
  confirm?: string;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
      aria-busy={pending}
    >
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div className={className}>{children}</div>
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
      {state.link ? (
        <div className="mt-2 space-y-1">
          <input
            readOnly
            aria-label="Invitation link"
            value={state.link}
            onFocus={(e) => e.currentTarget.select()}
            className="block w-full rounded-md border border-slate-300 bg-slate-50 px-2 py-1 font-mono text-xs"
          />
          <p className="text-xs text-slate-500">Share it only with the invited person. It works once.</p>
        </div>
      ) : null}
    </form>
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
