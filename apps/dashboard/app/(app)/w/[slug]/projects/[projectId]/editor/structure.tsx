'use client';
/**
 * P3 S4 (FR-BLD-03): changing the structure of the site. Sections: move, hide/show, duplicate, delete, change
 * variant, add (with placeholder content, approved 2026-11-15). Pages: add, rename, move, delete (never the home
 * page; its navigation links go with it). Every action is one PatchOperation list, validated by the server against
 * the whole SiteConfig and undoable like any other change. Buttons, not drag and drop: everything works from the
 * keyboard (FR-BLD-08).
 */
import { useId, useState } from 'react';
import type { DraftView } from '@platform/workspaces';
import { humanize } from './schema-form';

type Config = DraftView['config'];
type Page = Config['pages'][number];
type Section = Page['sections'][number];

export type Commit = (
  operations: unknown[],
  next?: { kind: 'page'; pageId: string } | { kind: 'section'; sectionId: string } | { kind: 'business' },
) => Promise<boolean>;

const button =
  'rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50';
const inputClass =
  'block w-full rounded-[var(--radius-base)] border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary)]/20';

const randomSuffix = () => Math.random().toString(36).slice(2, 6).padEnd(4, '0');

/** A section id unique in the config (`^[a-z0-9][a-z0-9-]{0,39}$`). */
function newSectionId(config: Config, type: string): string {
  const used = new Set(config.pages.flatMap((p) => p.sections.map((s) => s.id)));
  for (;;) {
    const id = `${type}-${randomSuffix()}`.slice(0, 40);
    if (!used.has(id)) return id;
  }
}

/** `Our Prices` → `our-prices`, unique among page ids and paths. */
function newPageId(config: Config, title: string): string {
  const base =
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'page';
  const taken = new Set(config.pages.flatMap((p) => [p.id, p.path.slice(1)]));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function ConfirmButton({
  label,
  onConfirm,
  disabled,
}: {
  label: string;
  onConfirm: () => void;
  disabled: boolean;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={button} disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span role="group" aria-label={`${label}: confirm`} className="inline-flex items-center gap-1">
      <span className="text-xs text-red-800">Sure?</span>
      <button
        type="button"
        className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        Yes, {label.toLowerCase()}
      </button>
      <button type="button" className={button} onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}

export function SectionTools({
  config,
  section,
  variants,
  disabled,
  commit,
}: {
  config: Config;
  section: Section;
  variants: readonly string[];
  disabled: boolean;
  commit: Commit;
}) {
  const id = useId();
  const page = config.pages.find((p) => p.sections.some((s) => s.id === section.id))!;
  const index = page.sections.findIndex((s) => s.id === section.id);
  const hidden = section.visible === false;
  return (
    <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Section actions">
        <button
          type="button"
          className={button}
          disabled={disabled || index === 0}
          onClick={() => void commit([{ op: 'moveSection', sectionId: section.id, toIndex: index - 1 }])}
        >
          Move section up
        </button>
        <button
          type="button"
          className={button}
          disabled={disabled || index === page.sections.length - 1}
          onClick={() => void commit([{ op: 'moveSection', sectionId: section.id, toIndex: index + 1 }])}
        >
          Move section down
        </button>
        <button
          type="button"
          className={button}
          disabled={disabled}
          aria-pressed={hidden}
          onClick={() => void commit([{ op: 'updateSection', sectionId: section.id, visible: hidden }])}
        >
          {hidden ? 'Show section' : 'Hide section'}
        </button>
        <button
          type="button"
          className={button}
          disabled={disabled}
          onClick={() => {
            const copy = { ...structuredClone(section), id: newSectionId(config, section.type) };
            void commit([{ op: 'addSection', pageId: page.id, index: index + 1, section: copy }], {
              kind: 'section',
              sectionId: copy.id,
            });
          }}
        >
          Duplicate section
        </button>
        <ConfirmButton
          label="Delete section"
          disabled={disabled}
          onConfirm={() =>
            void commit([{ op: 'removeSection', sectionId: section.id }], { kind: 'page', pageId: page.id })
          }
        />
      </div>
      {variants.length > 1 ? (
        <div className="space-y-1">
          <label htmlFor={`${id}-variant`} className="block text-sm font-medium">
            Layout
          </label>
          <select
            id={`${id}-variant`}
            className={inputClass}
            disabled={disabled}
            value={section.variant}
            onChange={(e) =>
              void commit([{ op: 'updateSection', sectionId: section.id, variant: e.target.value }])
            }
          >
            {variants.map((v) => (
              <option key={v} value={v}>
                {humanize(v)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}

export function AddSection({
  config,
  page,
  blocks,
  disabled,
  commit,
  afterSectionId,
}: {
  config: Config;
  page: Page;
  blocks: Record<string, { variants: readonly string[]; sample: Record<string, unknown> }>;
  disabled: boolean;
  commit: Commit;
  /** Insert after this section (the selected one on this page); otherwise at the end. */
  afterSectionId?: string;
}) {
  const id = useId();
  const types = Object.keys(blocks);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState(types[0] ?? '');
  const [variant, setVariant] = useState(blocks[types[0] ?? '']?.variants[0] ?? '');
  if (!open) {
    return (
      <button
        type="button"
        className={`${button} mt-1 w-full`}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        + Add section<span className="sr-only"> to {page.title}</span>
      </button>
    );
  }
  const after = page.sections.findIndex((s) => s.id === afterSectionId);
  return (
    <div className="mt-1 space-y-2 rounded-md border border-slate-200 p-2">
      <label htmlFor={`${id}-type`} className="block text-xs font-medium">
        Block
      </label>
      <select
        id={`${id}-type`}
        className={inputClass}
        value={type}
        onChange={(e) => {
          setType(e.target.value);
          setVariant(blocks[e.target.value]?.variants[0] ?? '');
        }}
      >
        {types.map((t) => (
          <option key={t} value={t}>
            {humanize(t)}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-variant`} className="block text-xs font-medium">
        Layout
      </label>
      <select
        id={`${id}-variant`}
        className={inputClass}
        value={variant}
        onChange={(e) => setVariant(e.target.value)}
      >
        {(blocks[type]?.variants ?? []).map((v) => (
          <option key={v} value={v}>
            {humanize(v)}
          </option>
        ))}
      </select>
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md bg-[var(--color-primary)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
          onClick={async () => {
            const section = {
              id: newSectionId(config, type),
              type,
              variant,
              visible: true,
              props: structuredClone(blocks[type]!.sample),
            };
            const ok = await commit(
              [
                {
                  op: 'addSection',
                  pageId: page.id,
                  index: after >= 0 ? after + 1 : page.sections.length,
                  section,
                },
              ],
              { kind: 'section', sectionId: section.id },
            );
            if (ok) setOpen(false);
          }}
        >
          Add {humanize(type).toLowerCase()}
        </button>
        <button type="button" className={button} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function PageTools({
  config,
  page,
  disabled,
  commit,
}: {
  config: Config;
  page: Page;
  disabled: boolean;
  commit: Commit;
}) {
  const id = useId();
  const [title, setTitle] = useState(page.title);
  const index = config.pages.findIndex((p) => p.id === page.id);
  const home = page.path === '/';
  return (
    <div className="space-y-4">
      <form
        className="space-y-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() && title !== page.title)
            void commit([{ op: 'updatePage', pageId: page.id, title: title.trim() }]);
        }}
      >
        <label htmlFor={`${id}-title`} className="block text-sm font-medium">
          Page name
        </label>
        <div className="flex gap-2">
          <input
            id={`${id}-title`}
            className={inputClass}
            value={title}
            maxLength={120}
            disabled={disabled}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button
            type="submit"
            className={button}
            disabled={disabled || !title.trim() || title === page.title}
          >
            Rename
          </button>
        </div>
        <p className="text-xs text-slate-600">
          Address: <span className="font-mono">{page.path}</span>
        </p>
      </form>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Page actions">
        <button
          type="button"
          className={button}
          disabled={disabled || index === 0}
          onClick={() => void commit([{ op: 'movePage', pageId: page.id, toIndex: index - 1 }])}
        >
          Move page up
        </button>
        <button
          type="button"
          className={button}
          disabled={disabled || index === config.pages.length - 1}
          onClick={() => void commit([{ op: 'movePage', pageId: page.id, toIndex: index + 1 }])}
        >
          Move page down
        </button>
        {home ? (
          <p className="text-xs text-slate-600">The home page cannot be deleted.</p>
        ) : (
          <ConfirmButton
            label="Delete page"
            disabled={disabled}
            onConfirm={() => void commit([{ op: 'removePage', pageId: page.id }], { kind: 'business' })}
          />
        )}
      </div>
    </div>
  );
}

export function AddPage({ config, disabled, commit }: { config: Config; disabled: boolean; commit: Commit }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  if (!open) {
    return (
      <button type="button" className={`${button} w-full`} disabled={disabled} onClick={() => setOpen(true)}>
        + Add page
      </button>
    );
  }
  return (
    <form
      className="space-y-2 rounded-md border border-slate-200 p-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const name = title.trim();
        if (!name) return;
        const pageId = newPageId(config, name);
        const ok = await commit(
          [{ op: 'addPage', page: { id: pageId, path: `/${pageId}`, title: name, sections: [] } }],
          { kind: 'page', pageId },
        );
        if (ok) {
          setOpen(false);
          setTitle('');
        }
      }}
    >
      <label htmlFor={`${id}-title`} className="block text-xs font-medium">
        New page name
      </label>
      <input
        id={`${id}-title`}
        className={inputClass}
        value={title}
        maxLength={120}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded-md bg-[var(--color-primary)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          disabled={!title.trim()}
        >
          Add page
        </button>
        <button type="button" className={button} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
