'use client';
/**
 * P3 S3: the site editor (module 05; FR-BLD-01/02/06/07, part of FR-BLD-08). Design approved by the Owner 2026-11-14,
 * preview decision 2026-11-15.
 *
 *   - Left: the business details and every section of every page; choosing one opens its form.
 *   - Middle: the form, generated from the block's schema. Changes save themselves one second after the last edit,
 *     on the revision the editor holds (someone else's newer save is a conflict: the draft reloads, nothing is lost
 *     silently on the server).
 *   - Right: the live preview, rendered by the dashboard (sandboxed iframe, no script), at phone/tablet/desktop width.
 *   - The edit lock is taken on open and renewed every 30 s; while someone else holds it, everything is read-only and
 *     owners/admins may take it over (audited).
 *   - Undo/redo buttons and Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) outside text fields, where the browser's own text undo
 *     applies.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DraftView } from '@platform/workspaces';
import {
  editLockAction,
  redoDraftAction,
  releaseEditLockAction,
  reloadDraftAction,
  saveDraftChangeAction,
  takeOverEditLockAction,
  undoDraftAction,
} from '@/app/actions/builder';
import { type FieldErrors, type JsonSchema, SchemaField, humanize } from './schema-form';

type Config = DraftView['config'];
type Section = Config['pages'][number]['sections'][number];
type Selection = { kind: 'business' } | { kind: 'section'; sectionId: string };
type Device = 'phone' | 'tablet' | 'desktop';
/** What the editor needs to know about the lock. Props cross the server/client boundary as plain JSON. */
type LockInfo = { holderUserId: string; mine: boolean };
export type ClientDraft = Omit<DraftView, 'lock'> & { lock: LockInfo | null };

const DEVICE_WIDTH: Record<Device, string> = { phone: '390px', tablet: '820px', desktop: '100%' };
const SAVE_DELAY_MS = 1000;
const HEARTBEAT_MS = 30_000;

export interface EditorProps {
  workspaceId: string;
  slug: string;
  initial: ClientDraft;
  schemas: { business: JsonSchema; blocks: Record<string, JsonSchema> };
  /** Owner, admin or editor in a writable workspace (the server re-checks every call). */
  canEdit: boolean;
  /** Owner or admin: may take a live lock over. */
  canTakeOver: boolean;
  memberNames: Record<string, string>;
}

function findSection(config: Config, sectionId: string): { section: Section; pagePath: string } | null {
  for (const page of config.pages) {
    const section = page.sections.find((s) => s.id === sectionId);
    if (section) return { section, pagePath: page.path };
  }
  return null;
}

/** Server field errors (`pages.0.sections.2.props.items.1.title`, `business.phone`) relative to the open form. */
function relativeErrors(
  fields: Record<string, string> | undefined,
  selection: Selection,
  config: Config,
): FieldErrors {
  const out: FieldErrors = {};
  for (const [key, message] of Object.entries(fields ?? {})) {
    if (selection.kind === 'business' && key.startsWith('business.'))
      out[key.slice('business.'.length)] = message;
    else if (selection.kind === 'section') {
      const m = /^pages\.(\d+)\.sections\.(\d+)\.props\.?(.*)$/.exec(key);
      const section = m ? config.pages[Number(m[1])]?.sections[Number(m[2])] : undefined;
      if (m && section?.id === selection.sectionId) out[m[3] ?? ''] = message;
    }
  }
  return out;
}

export function Editor({
  workspaceId,
  slug,
  initial,
  schemas,
  canEdit,
  canTakeOver,
  memberNames,
}: EditorProps) {
  const projectId = initial.projectId;
  const target = useMemo(() => ({ workspaceId, projectId }), [workspaceId, projectId]);
  const [config, setConfig] = useState<Config>(initial.config);
  const [revision, setRevision] = useState(initial.revision);
  const [history, setHistory] = useState({ canUndo: initial.canUndo, canRedo: initial.canRedo });
  const [lock, setLock] = useState<LockInfo | null>(initial.lock);
  const [selection, setSelection] = useState<Selection>({ kind: 'business' });
  const [working, setWorking] = useState<unknown>(initial.config.business);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState('');
  const [device, setDevice] = useState<Device>('desktop');
  const [busy, setBusy] = useState(false);

  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const configRef = useRef(config);
  configRef.current = config;
  const pending = useRef<{ selection: Selection; value: unknown } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);

  const holdsLock = lock?.mine === true;
  const editable = canEdit && holdsLock;

  const applyView = useCallback((view: ClientDraft) => {
    setConfig(view.config);
    setRevision(view.revision);
    setHistory({ canUndo: view.canUndo, canRedo: view.canRedo });
    setLock(view.lock);
  }, []);

  const reload = useCallback(async () => {
    const result = await reloadDraftAction(target);
    if (result.ok) applyView(result.value);
    return result.ok ? result.value : null;
  }, [target, applyView]);

  // Load the open form's value from the current config whenever the selection or the config changes.
  useEffect(() => {
    if (pending.current) return;
    if (selection.kind === 'business') setWorking(config.business);
    else setWorking(findSection(config, selection.sectionId)?.section.props);
  }, [config, selection]);

  const save = useCallback(async () => {
    const change = pending.current;
    if (!change) return;
    pending.current = null;
    const operations =
      change.selection.kind === 'business'
        ? [{ op: 'updateBusiness', value: change.value }]
        : [{ op: 'updateSection', sectionId: change.selection.sectionId, props: change.value }];
    setStatus('Saving…');
    const result = await saveDraftChangeAction({
      ...target,
      changeId: crypto.randomUUID(),
      expectedRevision: revisionRef.current,
      operations,
    });
    if (result.ok) {
      setErrors({});
      setProblem('');
      setRevision(result.value.revision);
      setHistory({ canUndo: true, canRedo: false });
      setConfig((current) => {
        if (change.selection.kind === 'business')
          return { ...current, business: change.value as Config['business'] };
        const sel = change.selection;
        return {
          ...current,
          pages: current.pages.map((p) => ({
            ...p,
            sections: p.sections.map((s) =>
              s.id === sel.sectionId ? ({ ...s, props: change.value } as Section) : s,
            ),
          })),
        };
      });
      setStatus('All changes saved');
      return;
    }
    setStatus('');
    if (result.code === 'INVALID_INPUT') {
      setErrors(relativeErrors(result.fieldErrors, change.selection, configRef.current));
      setProblem('Some fields need a fix before this change can be saved.');
    } else {
      setProblem(result.error);
      if (result.code === 'DRAFT_CONFLICT' || result.code === 'LOCK_REQUIRED') await reload();
    }
  }, [target, reload]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    while (saving.current) await saving.current;
    if (pending.current) {
      saving.current = save().finally(() => {
        saving.current = null;
      });
      await saving.current;
    }
  }, [save]);

  const edit = (value: unknown) => {
    setWorking(value);
    pending.current = { selection, value };
    setStatus('Unsaved changes');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  const choose = async (next: Selection) => {
    await flush();
    setErrors({});
    setSelection(next);
  };

  const reverse = useCallback(
    async (direction: 'undo' | 'redo') => {
      if (!editable || busy) return;
      await flush();
      setBusy(true);
      const action = direction === 'undo' ? undoDraftAction : redoDraftAction;
      const result = await action({ ...target, expectedRevision: revisionRef.current });
      setBusy(false);
      if (!result.ok) {
        setProblem(result.error);
        if (result.code === 'DRAFT_CONFLICT' || result.code === 'LOCK_REQUIRED') await reload();
        return;
      }
      setProblem('');
      await reload();
      setStatus(direction === 'undo' ? 'Undone' : 'Redone');
    },
    [editable, busy, flush, target, reload],
  );

  // The edit lock: take it on open, renew it every 30 s, give it back on leave (it also expires by itself).
  useEffect(() => {
    if (!canEdit) return;
    let active = true;
    const beat = async () => {
      const result = await editLockAction(target);
      if (active && result.ok) setLock(result.value.lock);
    };
    void beat();
    const interval = setInterval(() => void beat(), HEARTBEAT_MS);
    return () => {
      active = false;
      clearInterval(interval);
      void releaseEditLockAction(target);
    };
  }, [canEdit, target]);

  // Keyboard undo/redo outside text fields (inside them the browser's own text undo applies).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        void reverse('undo');
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        void reverse('redo');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reverse]);

  const takeOver = async () => {
    const result = await takeOverEditLockAction(target);
    if (!result.ok) return setProblem(result.error);
    await reload();
  };

  const selected = selection.kind === 'section' ? findSection(config, selection.sectionId) : null;
  const previewPath = selected?.pagePath ?? '/';
  const previewSrc = `/editor-preview/${slug}/${projectId}${previewPath === '/' ? '' : previewPath}?r=${revision}`;
  const formSchema =
    selection.kind === 'business' ? schemas.business : schemas.blocks[selected?.section.type ?? ''];
  const holderName = lock && !lock.mine ? (memberNames[lock.holderUserId] ?? 'Another member') : null;

  const itemClass = (active: boolean) =>
    `block w-full rounded-md px-3 py-2 text-left text-sm ${active ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`;

  return (
    <div className="space-y-4">
      {holderName ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-base)] border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <span>
            {holderName} is editing this site. You can look around; changes are off until they finish.
          </span>
          {canTakeOver ? (
            <button
              type="button"
              onClick={() => void takeOver()}
              className="rounded-md border border-amber-300 bg-white px-3 py-1.5 font-medium hover:bg-amber-100"
            >
              Take over editing
            </button>
          ) : null}
        </div>
      ) : null}
      {!canEdit ? (
        <p role="status" className="text-sm text-slate-600">
          You can view this site. Owners, admins and editors can change it.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void reverse('undo')}
          disabled={!editable || !history.canUndo || busy}
          aria-keyshortcuts="Control+Z"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={() => void reverse('redo')}
          disabled={!editable || !history.canRedo || busy}
          aria-keyshortcuts="Control+Y Control+Shift+Z"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          Redo
        </button>
        <span aria-live="polite" className="text-sm text-slate-600" data-testid="save-status">
          {status}
        </span>
        <div role="group" aria-label="Preview width" className="ml-auto flex gap-1">
          {(['phone', 'tablet', 'desktop'] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={device === d}
              onClick={() => setDevice(d)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm capitalize aria-pressed:bg-slate-900 aria-pressed:text-white"
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      {problem ? (
        <div
          role="alert"
          className="rounded-[var(--radius-base)] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {problem}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,22rem)_minmax(0,1fr)]">
        <nav aria-label="Site parts" className="space-y-3">
          <button
            type="button"
            aria-current={selection.kind === 'business' ? 'true' : undefined}
            className={itemClass(selection.kind === 'business')}
            onClick={() => void choose({ kind: 'business' })}
          >
            Business details
          </button>
          {config.pages.map((page) => (
            <div key={page.id}>
              <h2 className="px-3 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                {page.title}
              </h2>
              <ul className="mt-1 space-y-1">
                {page.sections.map((section) => {
                  const active = selection.kind === 'section' && selection.sectionId === section.id;
                  return (
                    <li key={section.id}>
                      <button
                        type="button"
                        aria-current={active ? 'true' : undefined}
                        className={itemClass(active)}
                        onClick={() => void choose({ kind: 'section', sectionId: section.id })}
                      >
                        {humanize(section.type)}
                        {section.visible === false ? <span className="ml-1 opacity-75">(hidden)</span> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <section
          aria-labelledby="form-title"
          className="space-y-4 rounded-[var(--radius-base)] border border-slate-200 bg-white p-4"
        >
          <h2 id="form-title" className="text-base font-semibold">
            {selection.kind === 'business'
              ? 'Business details'
              : humanize(selected?.section.type ?? 'Section')}
          </h2>
          {formSchema ? (
            <SchemaField
              key={selection.kind === 'business' ? 'business' : selection.sectionId}
              schema={formSchema}
              value={working}
              onChange={edit}
              label={selection.kind === 'business' ? 'Business' : 'Content'}
              path=""
              required
              errors={errors}
              disabled={!editable}
            />
          ) : (
            <p className="text-sm text-slate-600">This part cannot be edited here yet.</p>
          )}
        </section>

        <section
          aria-label="Live preview"
          className="min-w-0 rounded-[var(--radius-base)] border border-slate-200 bg-slate-100 p-2"
        >
          <iframe
            key={previewSrc}
            title="Site preview"
            src={previewSrc}
            sandbox="allow-same-origin"
            className="mx-auto block h-[70vh] rounded-md border border-slate-300 bg-white"
            style={{ width: DEVICE_WIDTH[device], maxWidth: '100%' }}
          />
        </section>
      </div>
    </div>
  );
}
