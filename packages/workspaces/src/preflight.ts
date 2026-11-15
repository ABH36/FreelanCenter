/**
 * P3 S7a: preflight before publishing (FR-PUB-04; module 06; approved 2026-11-15). Rule-based here; P4 adds AI
 * review on top. A pure function of the draft (and the template it came from), so the editor shows exactly what the
 * server will enforce: `publish` runs the same function inside its transaction and refuses on any blocking check.
 *
 * Blocking vs warning (approved decisions 2 and 3, and the rules below):
 *   schema              the draft is not a valid SiteConfig                                   blocking (both)
 *   demo-contact        the template's demo business name, phone, WhatsApp or e-mail is still   blocking for Live,
 *                       on the site (visitors would call a stranger)                             warning for Staging
 *   broken-link         a button or text link points to a page or section that does not exist,  blocking for Live,
 *                       or a call/WhatsApp/e-mail button has no number or address to use          warning for Staging
 *   form-destination    a contact form is shown but messages are not delivered until lead        warning (decision 2;
 *                       capture exists (module 09, P5)                                            blocking from P5)
 *   placeholder-text    text added by "Add section" was left unchanged                          warning
 *   alt-text            an image description is too short or generic for screen readers         warning
 *   contrast            theme colours below WCAG AA                                              warning
 *   seo                 a page has no search title or description                               warning
 *   mobile-overflow     a word too long to wrap on a phone screen                                warning
 *   empty-page          the home page shows no section                                           warning
 * Hidden sections are skipped: visitors never see them.
 */
import { SAMPLE_TEXTS, parseSiteConfig } from '@platform/schema';
import { contrastChecks } from '@platform/ui/color';

export type PublishKind = 'staging' | 'live';
export type PreflightLevel = 'blocking' | 'warning';

export type PreflightRule =
  | 'schema'
  | 'demo-contact'
  | 'broken-link'
  | 'form-destination'
  | 'placeholder-text'
  | 'alt-text'
  | 'contrast'
  | 'seo'
  | 'mobile-overflow'
  | 'empty-page';

export interface PreflightCheck {
  rule: PreflightRule;
  level: PreflightLevel;
  /** Plain words for the person publishing. Never contains the site's content beyond short labels. */
  message: string;
  /** Where on the site, in words ("Home > Contact"), when it is about one place. */
  where?: string;
}

export interface PreflightResult {
  /** No blocking check: publishing this kind is allowed. */
  ok: boolean;
  checks: PreflightCheck[];
}

export const PREFLIGHT_LIMITS = {
  /** Longest unbroken word that still wraps on a 320 px wide phone at body size. */
  maxWordLength: 28,
  minAltLength: 5,
  /** Checks of one rule listed one by one; the rest are summarised. */
  perRule: 8,
} as const;

const SAMPLES = new Set(SAMPLE_TEXTS);
const GENERIC_ALT =
  /^(image|img|photo|picture|pic|logo|banner|untitled|screenshot)\s*\d*$|\.(jpe?g|png|webp|gif)$/i;
const URLISH = /^(https?:|mailto:|tel:|www\.)/i;

type Json = unknown;

function* strings(value: Json, path: string[] = []): Generator<{ text: string; key: string }> {
  if (typeof value === 'string') yield { text: value, key: path[path.length - 1] ?? '' };
  else if (Array.isArray(value)) for (const v of value) yield* strings(v, path);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, Json>)) yield* strings(v, [...path, k]);
  }
}

function* objects(value: Json): Generator<Record<string, Json>> {
  if (Array.isArray(value)) for (const v of value) yield* objects(v);
  else if (value && typeof value === 'object') {
    yield value as Record<string, Json>;
    for (const v of Object.values(value as Record<string, Json>)) yield* objects(v);
  }
}

const label = (type: string) =>
  type === 'cta-banner' ? 'Call-to-action banner' : `${type.charAt(0).toUpperCase()}${type.slice(1)}`;

const sameValue = (a: string | undefined, b: string | undefined, normalise: (s: string) => string) =>
  Boolean(a && b && normalise(a) === normalise(b));
const digits = (s: string) => s.replace(/\D/g, '').slice(-10);
const lower = (s: string) => s.trim().toLowerCase();

export function runPreflight(input: {
  config: unknown;
  kind: PublishKind;
  /** The catalogue template the draft started from, to recognise its demo contact details. */
  template?: unknown;
}): PreflightResult {
  const parsed = parseSiteConfig(input.config);
  if (!parsed.ok) {
    return {
      ok: false,
      checks: [
        {
          rule: 'schema',
          level: 'blocking',
          message: 'The site data is not valid. Reload the editor; if this stays, contact support.',
        },
      ],
    };
  }
  const config = parsed.config;
  const strict: PreflightLevel = input.kind === 'live' ? 'blocking' : 'warning';
  const checks: PreflightCheck[] = [];
  const add = (check: PreflightCheck) => checks.push(check);

  // ---- demo contact details (decision 3)
  const demo = input.template ? parseSiteConfig(input.template) : null;
  if (demo?.ok) {
    const a = config.business;
    const b = demo.config.business;
    const left: string[] = [];
    if (sameValue(a.name, b.name, lower)) left.push('business name');
    if (sameValue(a.phone, b.phone, digits)) left.push('phone number');
    if (sameValue(a.whatsapp, b.whatsapp, digits)) left.push('WhatsApp number');
    if (sameValue(a.email, b.email, lower)) left.push('e-mail address');
    if (left.length) {
      add({
        rule: 'demo-contact',
        level: strict,
        message: `The template's sample ${left.length > 1 ? `${left.slice(0, -1).join(', ')} and ${left[left.length - 1]}` : left[0]} ${left.length > 1 ? 'are' : 'is'} still on the site. Replace ${left.length > 1 ? 'them' : 'it'} with the business's own in Business details.`,
        where: 'Business details',
      });
    }
  }

  // ---- links and buttons
  const sectionsByPath = new Map(
    config.pages.map((p) => [p.path, new Set(p.sections.filter((s) => s.visible).map((s) => s.id))]),
  );
  const brokenTarget = (target: string): string | null => {
    if (!target.startsWith('/') && !target.startsWith('#')) return null; // external, checked by the schema
    const [base = '', anchor] = target.split('#');
    const sections = sectionsByPath.get(base === '' ? '/' : base);
    if (!sections) return 'a page that does not exist';
    if (anchor !== undefined && !sections.has(anchor)) return 'a section that does not exist or is hidden';
    return null;
  };
  const business = config.business;
  const contactMissing = (action: string): string | null => {
    if (action === 'whatsapp' && !business.whatsapp && !business.phone) return 'a WhatsApp number';
    if (action === 'tel' && !business.phone) return 'a phone number';
    if (action === 'mailto' && !business.email) return 'an e-mail address';
    return null;
  };
  const linkIssues: PreflightCheck[] = [];
  const checkLinks = (value: Json, where: string) => {
    for (const obj of objects(value)) {
      if (typeof obj['action'] === 'string' && typeof obj['label'] === 'string') {
        const missing = contactMissing(obj['action']);
        const broken = typeof obj['target'] === 'string' ? brokenTarget(obj['target']) : null;
        if (missing) {
          linkIssues.push({
            rule: 'broken-link',
            level: strict,
            message: `The button "${obj['label'].slice(0, 40)}" needs ${missing} in Business details.`,
            where,
          });
        } else if (broken && (obj['action'] === 'link' || obj['action'] === 'scroll')) {
          linkIssues.push({
            rule: 'broken-link',
            level: strict,
            message: `The button "${obj['label'].slice(0, 40)}" goes to ${broken}.`,
            where,
          });
        }
      } else if (obj['type'] === 'link' && typeof obj['href'] === 'string') {
        const broken = brokenTarget(obj['href']);
        if (broken) {
          linkIssues.push({
            rule: 'broken-link',
            level: strict,
            message: `The text link "${String(obj['text'] ?? '').slice(0, 40)}" goes to ${broken}.`,
            where,
          });
        }
      }
    }
  };
  if (config.navigation.cta) checkLinks(config.navigation.cta, 'Navigation');
  for (const item of config.navigation.items) {
    const broken = brokenTarget(item.target);
    if (broken) {
      linkIssues.push({
        rule: 'broken-link',
        level: strict,
        message: `The menu link "${item.label.slice(0, 40)}" goes to ${broken}.`,
        where: 'Navigation',
      });
    }
  }
  const floating = config.footer.floatingAction;
  if ((floating === 'whatsapp' || floating === 'both') && contactMissing('whatsapp')) {
    linkIssues.push({
      rule: 'broken-link',
      level: strict,
      message: 'The floating WhatsApp button needs a WhatsApp number in Business details.',
      where: 'Footer',
    });
  }
  if ((floating === 'call' || floating === 'both') && contactMissing('tel')) {
    linkIssues.push({
      rule: 'broken-link',
      level: strict,
      message: 'The floating call button needs a phone number in Business details.',
      where: 'Footer',
    });
  }

  // ---- per section
  const placeholders: PreflightCheck[] = [];
  const alts: PreflightCheck[] = [];
  const overflow: PreflightCheck[] = [];
  let form: string | null = null;
  const checkAlt = (value: Json, where: string) => {
    for (const obj of objects(value)) {
      if (typeof obj['assetId'] === 'string' && typeof obj['alt'] === 'string') {
        const alt = obj['alt'].trim();
        if (alt.length < PREFLIGHT_LIMITS.minAltLength || GENERIC_ALT.test(alt)) {
          alts.push({
            rule: 'alt-text',
            level: 'warning',
            message: `An image is described only as "${alt.slice(0, 30)}". Say what the picture shows, for people who cannot see it.`,
            where,
          });
        }
      }
    }
  };
  if (business.logo) checkAlt(business.logo, 'Business details');
  for (const page of config.pages) {
    for (const section of page.sections) {
      if (!section.visible) continue;
      const where = `${page.title} > ${label(section.type)}`;
      checkLinks(section.props, where);
      checkAlt(section.props, where);
      const seen = new Set<string>();
      for (const { text, key } of strings(section.props)) {
        if (SAMPLES.has(text) && !seen.has(text)) {
          seen.add(text);
          placeholders.push({
            rule: 'placeholder-text',
            level: 'warning',
            message: `The sample text "${text.slice(0, 40)}" is still there. Write the business's own.`,
            where,
          });
        }
        if (key === 'href' || key === 'target' || key === 'assetId') continue;
        const long = text
          .split(/\s+/)
          .find((w) => w.length > PREFLIGHT_LIMITS.maxWordLength && !URLISH.test(w));
        if (long) {
          overflow.push({
            rule: 'mobile-overflow',
            level: 'warning',
            message: `"${long.slice(0, 24)}..." is one very long word and may not fit on a phone screen. Add spaces or shorten it.`,
            where,
          });
        }
      }
      if (section.type === 'contact' && section.variant !== 'details' && !form) form = where;
    }
  }
  const limit = (list: PreflightCheck[]) => {
    for (const c of list.slice(0, PREFLIGHT_LIMITS.perRule)) add(c);
    if (list.length > PREFLIGHT_LIMITS.perRule) {
      add({
        rule: list[0]!.rule,
        level: list[0]!.level,
        message: `And ${list.length - PREFLIGHT_LIMITS.perRule} more like this.`,
      });
    }
  };
  // Blocking ones first, so the list starts with what must be fixed.
  limit(linkIssues);
  if (form) {
    add({
      rule: 'form-destination',
      level: 'warning',
      message:
        'The contact form is shown, but its messages are not delivered yet (lead capture comes in a later update). Visitors can still call or message on WhatsApp.',
      where: form,
    });
  }
  limit(placeholders);
  limit(alts);

  // ---- theme, SEO, layout
  const contrast = contrastChecks(config.theme.colors, config.theme.buttons.style);
  if (contrast.length) {
    add({
      rule: 'contrast',
      level: 'warning',
      message: `${contrast.length} colour pair${contrast.length > 1 ? 's are' : ' is'} hard to read (for example ${contrast[0]!.pair}). Pick a ready-made palette in Theme.`,
      where: 'Theme',
    });
  }
  for (const page of config.pages) {
    const missing = [!page.seo?.title && 'title', !page.seo?.description && 'description'].filter(Boolean);
    if (missing.length) {
      add({
        rule: 'seo',
        level: 'warning',
        message: `The page has no search ${missing.join(' or ')}. Add ${missing.length > 1 ? 'them' : 'it'} so the page shows well on Google.`,
        where: page.title,
      });
    }
  }
  limit(overflow);
  const home = config.pages.find((p) => p.path === '/');
  if (home && !home.sections.some((s) => s.visible)) {
    add({
      rule: 'empty-page',
      level: 'warning',
      message: 'The home page shows no section.',
      where: home.title,
    });
  }

  checks.sort((a, b) => (a.level === b.level ? 0 : a.level === 'blocking' ? -1 : 1));
  return { ok: !checks.some((c) => c.level === 'blocking'), checks };
}
