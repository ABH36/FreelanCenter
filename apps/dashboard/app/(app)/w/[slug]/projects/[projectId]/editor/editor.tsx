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
import { AssetLibraryProvider, LibraryPanel } from './assets';
import { FeedbackPanel } from './feedback';
import { PublishPanel } from './publish';
import { reviewFeedbackAction } from '@/app/actions/review';
import { type FieldErrors, type JsonSchema, SchemaField, humanize } from './schema-form';
import { AddPage, AddSection, type Commit, PageTools, SectionTools } from './structure';
import { type FontOption, ThemeForm, themePatchValue } from './theme-form';

type Config = DraftView['config'];
type Section = Config['pages'][number]['sections'][number];
type Selection =
  | { kind: 'business' }
  | { kind: 'theme' }
  | { kind: 'images' }
  | { kind: 'publish' }
  | { kind: 'feedback' }
  | { kind: 'section'; sectionId: string }
  | { kind: 'page'; pageId: string };
type Device = 'phone' | 'tablet' | 'desktop';
/** What the editor needs to know about the lock. Props cross the server/client boundary as plain JSON. */
type LockInfo = { holderUserId: string; mine: boolean };
export type ClientDraft = Omit<DraftView, 'lock'> & { lock: LockInfo | null };

/** The width the site is laid out at for each device; the preview scales it down to fit the column. */
const DEVICE_WIDTH: Record<Device, number> = { phone: 390, tablet: 820, desktop: 1280 };
const PREVIEW_HEIGHT = 640;

/**
 * Lays the site out at the real device width and scales it to the column, so phone, tablet and desktop differ even
 * when the column is narrower than a tablet (extension check 2026-11-15: Tablet and Desktop looked the same).
 */
function ScaledPreview({ src, width }: { src: string; width: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(width);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry?.contentRect.width ?? width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [width]);
  const scale = Math.min(1, available / width);
  return (
    <div ref={box} className="w-full">
      <div
        className="mx-auto overflow-hidden rounded-md border border-slate-300 bg-white"
        style={{ width: width * scale, height: PREVIEW_HEIGHT }}
        data-testid="preview-frame"
        data-device-width={width}
      >
        <iframe
          key={src}
          title="Site preview"
          src={src}
          sandbox="allow-same-origin"
          className="block origin-top-left border-0"
          style={{ width, height: PREVIEW_HEIGHT / scale, transform: `scale(${scale})` }}
        />
      </div>
      <p className="mt-1 text-center text-xs text-slate-700">
        {width}px wide{scale < 1 ? `, shown at ${Math.round(scale * 100)}%` : ''}
      </p>
    </div>
  );
}
const SAVE_DELAY_MS = 1000;
const HEARTBEAT_MS = 30_000;

export interface EditorProps {
  workspaceId: string;
  slug: string;
  initial: ClientDraft;
  schemas: { business: JsonSchema; blocks: Record<string, JsonSchema> };
  /** P3 S4: each block type's layouts and the placeholder content of a new section (from @platform/schema). */
  blocks: Record<string, { variants: readonly string[]; sample: Record<string, unknown> }>;
  /** P3 S5: the font allow-list (from @platform/schema). */
  fonts: readonly FontOption[];
  /** Owner, admin or editor in a writable workspace (the server re-checks every call). */
  canEdit: boolean;
  /** Owner or admin: may take a live lock over. */
  canTakeOver: boolean;
  memberNames: Record<string, string>;
  /** P3 S6: image uploads are configured in this environment (ASSET_*). */
  uploadsEnabled: boolean;
  /** P3 S7a (decision 4): owner/admin/editor publish to staging; owner/admin to live. The server re-checks. */
  canPublishStaging: boolean;
  canPublishLive: boolean;
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
  blocks,
  fonts,
  canEdit,
  canTakeOver,
  memberNames,
  uploadsEnabled,
  canPublishStaging,
  canPublishLive,
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
  const [status, setStatus] = useState('All changes saved');
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
    else if (selection.kind === 'theme') setWorking(config.theme);
    else if (selection.kind === 'section') {
      const found = findSection(config, selection.sectionId);
      if (found) setWorking(found.section.props);
      else setSelection({ kind: 'business' });
    } else if (selection.kind === 'page' && !config.pages.some((p) => p.id === selection.pageId))
      setSelection({ kind: 'business' });
  }, [config, selection]);

  const save = useCallback(async () => {
    const change = pending.current;
    if (!change || change.selection.kind === 'page') return;
    pending.current = null;
    const formTarget = change.selection;
    const operations =
      change.selection.kind === 'business'
        ? [{ op: 'updateBusiness', value: change.value }]
        : change.selection.kind === 'theme'
          ? [{ op: 'updateTheme', value: themePatchValue(change.value as Config['theme']) }]
          : [
              {
                op: 'updateSection',
                sectionId: formTarget.kind === 'section' ? formTarget.sectionId : '',
                props: change.value,
              },
            ];
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
        if (change.selection.kind === 'theme') return { ...current, theme: change.value as Config['theme'] };
        const sel = change.selection;
        return {
          ...current,
          pages: current.pages.map((p) => ({
            ...p,
            sections: p.sections.map((s) =>
              sel.kind === 'section' && s.id === sel.sectionId
                ? ({ ...s, props: change.value } as Section)
                : s,
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

  // P3 S8a: open client comments, for the menu entry (the panel refreshes it after a reply or resolve).
  const [openFeedback, setOpenFeedback] = useState<number | null>(null);
  useEffect(() => {
    void reviewFeedbackAction(target).then((r) => {
      if (r.ok) setOpenFeedback(r.value.open);
    });
  }, [target]);

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
      setStatus(direction === 'undo' ? 'Undone · all changes saved' : 'Redone · all changes saved');
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

  /** Structure changes (S4) save at once, then the draft reloads from the server. */
  const commit: Commit = useCallback(
    async (operations, next) => {
      if (!editable || busy) return false;
      await flush();
      setBusy(true);
      setStatus('Saving…');
      const result = await saveDraftChangeAction({
        ...target,
        changeId: crypto.randomUUID(),
        expectedRevision: revisionRef.current,
        operations,
      });
      setBusy(false);
      if (!result.ok) {
        setStatus('');
        setProblem(
          result.code === 'INVALID_INPUT'
            ? (Object.values(result.fieldErrors ?? {})[0] ?? result.error)
            : result.error,
        );
        if (result.code === 'DRAFT_CONFLICT' || result.code === 'LOCK_REQUIRED') await reload();
        return false;
      }
      setProblem('');
      setErrors({});
      await reload();
      if (next) setSelection(next);
      setStatus('All changes saved');
      return true;
    },
    [editable, busy, flush, target, reload],
  );

  /** P3 S7a: publishing publishes the saved revision, so anything still waiting is saved first. */
  const prepare = useCallback(async () => {
    await flush();
    return revisionRef.current;
  }, [flush]);

  const takeOver = async () => {
    const result = await takeOverEditLockAction(target);
    if (!result.ok) return setProblem(result.error);
    await reload();
  };

  const selected = selection.kind === 'section' ? findSection(config, selection.sectionId) : null;
  const selectedPage =
    selection.kind === 'page' ? config.pages.find((p) => p.id === selection.pageId) : undefined;
  const previewPath = selected?.pagePath ?? selectedPage?.path ?? '/';
  const previewSrc = `/editor-preview/${slug}/${projectId}${previewPath === '/' ? '' : previewPath}?r=${revision}`;
  const formSchema =
    selection.kind === 'business'
      ? schemas.business
      : selection.kind === 'section'
        ? schemas.blocks[selected?.section.type ?? '']
        : undefined;
  const holderName = lock && !lock.mine ? (memberNames[lock.holderUserId] ?? 'Another member') : null;

  const itemClass = (active: boolean) =>
    `block w-full rounded-md px-3 py-2 text-left text-sm ${active ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`;

  return (
    <AssetLibraryProvider target={target} enabled={uploadsEnabled} canManage={canEdit}>
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

        {/* Wide screens: list, form, preview side by side. Medium: list and form, preview below at full width. */}
        <div className="grid gap-4 md:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,22rem)_minmax(0,1fr)]">
          <nav aria-label="Site parts" className="space-y-3">
            <button
              type="button"
              aria-current={selection.kind === 'business' ? 'true' : undefined}
              className={itemClass(selection.kind === 'business')}
              onClick={() => void choose({ kind: 'business' })}
            >
              Business details
            </button>
            <button
              type="button"
              aria-current={selection.kind === 'theme' ? 'true' : undefined}
              className={itemClass(selection.kind === 'theme')}
              onClick={() => void choose({ kind: 'theme' })}
            >
              Theme
            </button>
            <button
              type="button"
              aria-current={selection.kind === 'images' ? 'true' : undefined}
              className={itemClass(selection.kind === 'images')}
              onClick={() => void choose({ kind: 'images' })}
            >
              Images
            </button>
            <button
              type="button"
              aria-current={selection.kind === 'publish' ? 'true' : undefined}
              className={itemClass(selection.kind === 'publish')}
              onClick={() => void choose({ kind: 'publish' })}
            >
              Publish
            </button>
            <button
              type="button"
              aria-current={selection.kind === 'feedback' ? 'true' : undefined}
              className={itemClass(selection.kind === 'feedback')}
              onClick={() => void choose({ kind: 'feedback' })}
            >
              Client feedback
              {openFeedback ? (
                <span
                  className="ml-2 rounded-full bg-amber-200 px-2 py-0.5 text-xs text-amber-950"
                  data-testid="feedback-count"
                >
                  {openFeedback}
                  <span className="sr-only"> open</span>
                </span>
              ) : null}
            </button>
            {config.pages.map((page) => (
              <div key={page.id}>
                <h2>
                  <button
                    type="button"
                    aria-current={
                      selection.kind === 'page' && selection.pageId === page.id ? 'true' : undefined
                    }
                    className={`${itemClass(selection.kind === 'page' && selection.pageId === page.id)} text-xs font-semibold tracking-wide uppercase`}
                    onClick={() => void choose({ kind: 'page', pageId: page.id })}
                  >
                    {page.title}
                    <span className="sr-only"> page settings</span>
                  </button>
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
                          {section.visible === false ? <span className="opacity-75"> (hidden)</span> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <AddSection
                  config={config}
                  page={page}
                  blocks={blocks}
                  disabled={!editable || busy}
                  commit={commit}
                  afterSectionId={selection.kind === 'section' ? selection.sectionId : undefined}
                />
              </div>
            ))}
            <AddPage config={config} disabled={!editable || busy} commit={commit} />
          </nav>

          <section
            aria-labelledby="form-title"
            className="space-y-4 rounded-[var(--radius-base)] border border-slate-200 bg-white p-4"
          >
            <h2 id="form-title" className="text-base font-semibold">
              {selection.kind === 'business'
                ? 'Business details'
                : selection.kind === 'theme'
                  ? 'Theme'
                  : selection.kind === 'images'
                    ? 'Images'
                    : selection.kind === 'publish'
                      ? 'Publish'
                      : selection.kind === 'feedback'
                        ? 'Client feedback'
                        : selection.kind === 'page'
                          ? `Page: ${selectedPage?.title ?? ''}`
                          : humanize(selected?.section.type ?? 'Section')}
            </h2>
            {selection.kind === 'section' && selected ? (
              <SectionTools
                key={`tools-${selected.section.id}`}
                config={config}
                section={selected.section}
                variants={blocks[selected.section.type]?.variants ?? []}
                disabled={!editable || busy}
                commit={commit}
              />
            ) : null}
            {selection.kind === 'page' && selectedPage ? (
              <PageTools
                key={`page-${selectedPage.id}-${selectedPage.title}`}
                config={config}
                page={selectedPage}
                disabled={!editable || busy}
                commit={commit}
              />
            ) : null}
            {formSchema ? (
              <SchemaField
                key={selection.kind === 'section' ? selection.sectionId : selection.kind}
                schema={formSchema}
                value={working}
                onChange={edit}
                label={selection.kind === 'business' ? 'Business' : 'Content'}
                path=""
                required
                errors={errors}
                disabled={!editable}
              />
            ) : selection.kind === 'theme' ? (
              <ThemeForm
                // Right after switching, `working` can still hold the previous form's value for one render.
                theme={
                  working && typeof working === 'object' && 'colors' in working
                    ? (working as Config['theme'])
                    : config.theme
                }
                onChange={edit}
                fonts={fonts}
                language={config.business.language}
                disabled={!editable}
              />
            ) : selection.kind === 'images' ? (
              <LibraryPanel />
            ) : selection.kind === 'publish' ? (
              <PublishPanel
                target={target}
                prepare={prepare}
                canPublishStaging={canPublishStaging}
                canPublishLive={canPublishLive}
                historyHref={`/w/${slug}/projects/${target.projectId}/history`}
              />
            ) : selection.kind === 'feedback' ? (
              <FeedbackPanel
                target={target}
                config={config}
                canReply={canEdit}
                onShowSection={(sectionId) => void choose({ kind: 'section', sectionId })}
                onOpenCount={setOpenFeedback}
              />
            ) : selection.kind === 'page' ? null : (
              <p className="text-sm text-slate-600">This part cannot be edited here yet.</p>
            )}
          </section>

          <section
            aria-label="Live preview"
            className="min-w-0 rounded-[var(--radius-base)] border border-slate-200 bg-slate-100 p-2 md:col-span-2 xl:col-span-1"
          >
            <ScaledPreview src={previewSrc} width={DEVICE_WIDTH[device]} />
          </section>
        </div>
      </div>
    </AssetLibraryProvider>
  );
}
