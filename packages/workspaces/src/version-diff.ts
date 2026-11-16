/**
 * P3 S7b: what changed between two site versions (FR-PUB-03 "JSON diff"; module 06; plan approved by the Owner
 * 2026-11-16). A pure function of two SiteConfigs, so the dashboard and the tests see the same answer.
 *
 * The diff is structured by what a freelancer recognises, not by JSON paths:
 *   business   a business detail (name, phone, address city ...)
 *   theme      a colour, font, shape ...
 *   navigation the menu items or the menu button
 *   footer / integrations
 *   page       a page added, removed, moved, renamed, or its address / search title changed
 *   section    a section added, removed, moved, hidden, shown, its layout or one of its fields changed
 *
 * Values are shown as short plain text (rich text flattened, images by their description, at most
 * `DIFF_LIMITS.valueChars` characters), never as markup. At most `DIFF_LIMITS.entries` entries are listed; the
 * rest are counted.
 */
import type { SiteConfig } from '@platform/schema';

export type DiffArea = 'business' | 'theme' | 'navigation' | 'footer' | 'integrations' | 'page' | 'section';
export type DiffChange = 'added' | 'removed' | 'changed' | 'moved' | 'hidden' | 'shown';

export interface DiffEntry {
  area: DiffArea;
  change: DiffChange;
  /** In words: "Business details", "Home", "Home > Services". */
  where: string;
  /** The field, in words ("Phone", "Items 2 > Title"), when the entry is about one field. */
  field?: string;
  before?: string;
  after?: string;
  /** The page to open in the side-by-side preview (a site path); absent for site-wide changes. */
  path?: string;
}

export interface VersionDiff {
  entries: DiffEntry[];
  /** Entries left out beyond the limit. */
  more: number;
  /** Nothing differs. */
  same: boolean;
}

export const DIFF_LIMITS = { entries: 200, valueChars: 80, depth: 6 } as const;

type Json = unknown;
type Page = SiteConfig['pages'][number];
type Section = Page['sections'][number];

const isObject = (v: Json): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);
const isRich = (v: Json): v is { type: string; text?: string }[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((n) => isObject(n) && (n.type === 'text' || n.type === 'link' || n.type === 'br'));
const isAssetRef = (v: Json): v is { assetId: string; alt: string } =>
  isObject(v) && typeof v.assetId === 'string' && typeof v.alt === 'string' && Object.keys(v).length === 2;

const clip = (s: string) =>
  s.length > DIFF_LIMITS.valueChars ? `${s.slice(0, DIFF_LIMITS.valueChars - 1).trimEnd()}…` : s;

/** A value as short plain text. */
function show(v: Json): string {
  if (v === undefined || v === null || v === '') return '(empty)';
  if (typeof v === 'string') return clip(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (isRich(v)) return clip(v.map((n) => (n.type === 'br' ? ' ' : (n.text ?? ''))).join('')) || '(empty)';
  if (isAssetRef(v)) return clip(`Image "${v.alt}"`);
  if (Array.isArray(v)) return clip(v.map(show).join(', ')) || '(empty)';
  return clip(JSON.stringify(v));
}

/** "postalCode" -> "Postal code", "cta" -> "Button". */
function words(key: string): string {
  const named: Record<string, string> = {
    cta: 'Button',
    whatsapp: 'WhatsApp',
    seo: 'Search',
    ogImage: 'Share image',
    noindex: 'Hidden from search',
    analyticsId: 'Analytics id',
    metaPixelId: 'Meta pixel id',
    floatingAction: 'Floating button',
    showPlatformBadge: 'Platform badge',
  };
  if (named[key]) return named[key];
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** The leaves of a value, with readable field names. Rich text, images and lists of plain values are one leaf. */
function leaves(v: Json, field: string[] = [], out = new Map<string, Json>(), depth = 0): Map<string, Json> {
  const name = field.join(' > ');
  if (
    depth >= DIFF_LIMITS.depth ||
    !v ||
    typeof v !== 'object' ||
    isRich(v) ||
    isAssetRef(v) ||
    (Array.isArray(v) && v.every((x) => !x || typeof x !== 'object'))
  ) {
    out.set(name, v);
    return out;
  }
  if (Array.isArray(v)) {
    // "Items 2 > Title": the list's own name carries the position.
    const head = field.slice(0, -1);
    const list = field[field.length - 1] ?? 'Item';
    v.forEach((item, i) => leaves(item, [...head, `${list} ${i + 1}`], out, depth + 1));
    if (v.length === 0) out.set(name, v);
    return out;
  }
  const entries = Object.entries(v);
  for (const [k, child] of entries) leaves(child, [...field, words(k)], out, depth + 1);
  if (entries.length === 0) out.set(name, v);
  return out;
}

const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);

/** Field-level changes between two values of one part. */
function fieldChanges(
  a: Json,
  b: Json,
  base: Omit<DiffEntry, 'change' | 'field' | 'before' | 'after'>,
  push: (e: DiffEntry) => void,
) {
  if (same(a, b)) return;
  const before = leaves(a);
  const after = leaves(b);
  const fields = [...new Set([...before.keys(), ...after.keys()])];
  for (const f of fields) {
    const x = before.get(f);
    const y = after.get(f);
    if (same(x, y)) continue;
    push({
      ...base,
      change: x === undefined ? 'added' : y === undefined ? 'removed' : 'changed',
      ...(f ? { field: f } : {}),
      before: show(x),
      after: show(y),
    });
  }
}

const sectionLabel = (s: Section) =>
  s.type === 'cta-banner' ? 'Call-to-action banner' : `${s.type.charAt(0).toUpperCase()}${s.type.slice(1)}`;

/** The relative order of the ids two lists share changed for these ids (a simple, stable "moved" signal). */
function moved(beforeIds: string[], afterIds: string[]): Set<string> {
  const common = new Set(beforeIds.filter((id) => afterIds.includes(id)));
  const a = beforeIds.filter((id) => common.has(id));
  const b = afterIds.filter((id) => common.has(id));
  const out = new Set<string>();
  a.forEach((id, i) => {
    if (b[i] !== id) out.add(id);
  });
  return out;
}

/** What changed from `a` (the older or "before" version) to `b`. */
export function diffConfigs(a: SiteConfig, b: SiteConfig, options: { limit?: number } = {}): VersionDiff {
  const limit = options.limit ?? DIFF_LIMITS.entries;
  const entries: DiffEntry[] = [];
  let more = 0;
  const push = (e: DiffEntry) => {
    if (entries.length < limit) entries.push(e);
    else more++;
  };

  fieldChanges(a.business, b.business, { area: 'business', where: 'Business details' }, push);
  fieldChanges(a.theme, b.theme, { area: 'theme', where: 'Theme' }, push);
  fieldChanges(a.navigation, b.navigation, { area: 'navigation', where: 'Menu' }, push);
  fieldChanges(a.footer, b.footer, { area: 'footer', where: 'Footer' }, push);
  fieldChanges(a.integrations, b.integrations, { area: 'integrations', where: 'Integrations' }, push);

  const pagesA = new Map(a.pages.map((p) => [p.id, p]));
  const pagesB = new Map(b.pages.map((p) => [p.id, p]));
  const pageMoves = moved(
    a.pages.map((p) => p.id),
    b.pages.map((p) => p.id),
  );
  // Where each section lives, site-wide (section ids are unique across the whole site).
  const homeOf = (config: SiteConfig) => {
    const out = new Map<string, { page: Page; section: Section }>();
    for (const page of config.pages)
      for (const section of page.sections) out.set(section.id, { page, section });
    return out;
  };
  const sectionsA = homeOf(a);
  const sectionsB = homeOf(b);

  for (const page of b.pages) {
    const old = pagesA.get(page.id);
    if (!old) {
      push({ area: 'page', change: 'added', where: page.title, path: page.path });
      continue;
    }
    if (pageMoves.has(page.id)) push({ area: 'page', change: 'moved', where: page.title, path: page.path });
    fieldChanges(
      { title: old.title, path: old.path, seo: old.seo ?? {} },
      { title: page.title, path: page.path, seo: page.seo ?? {} },
      { area: 'page', where: page.title, path: page.path },
      push,
    );
  }
  for (const page of a.pages) {
    if (!pagesB.has(page.id)) push({ area: 'page', change: 'removed', where: page.title });
  }

  for (const page of b.pages) {
    const old = pagesA.get(page.id);
    const sectionMoves = old
      ? moved(
          old.sections.map((s) => s.id),
          page.sections.map((s) => s.id),
        )
      : new Set<string>();
    for (const section of page.sections) {
      const where = `${page.title} > ${sectionLabel(section)}`;
      const base = { area: 'section' as const, where, path: page.path };
      const was = sectionsA.get(section.id);
      if (!was) {
        if (old) push({ ...base, change: 'added' });
        continue; // a new page's sections are part of "page added"
      }
      if (was.page.id !== page.id)
        push({ ...base, change: 'moved', before: was.page.title, after: page.title });
      else if (sectionMoves.has(section.id)) push({ ...base, change: 'moved' });
      if (was.section.visible !== section.visible)
        push({ ...base, change: section.visible ? 'shown' : 'hidden' });
      if (was.section.variant !== section.variant) {
        push({
          ...base,
          change: 'changed',
          field: 'Layout',
          before: was.section.variant,
          after: section.variant,
        });
      }
      fieldChanges(was.section.props, section.props, base, push);
      fieldChanges(
        { style: was.section.style ?? {}, motion: was.section.motion ?? {} },
        { style: section.style ?? {}, motion: section.motion ?? {} },
        base,
        push,
      );
    }
  }
  for (const page of a.pages) {
    if (!pagesB.has(page.id)) continue; // listed as "page removed"
    for (const section of page.sections) {
      if (!sectionsB.has(section.id)) {
        push({ area: 'section', change: 'removed', where: `${page.title} > ${sectionLabel(section)}` });
      }
    }
  }

  return { entries, more, same: entries.length === 0 && more === 0 };
}
