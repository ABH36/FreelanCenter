/**
 * Building blocks of SiteConfig v1.0 (SRS 5.2 config rules). Everything here is a *closed* vocabulary: text is data,
 * never markup; URLs are scheme-allow-listed; colours are 6-digit hex; images are asset ids with mandatory alt.
 */
import { z } from 'zod';

/** Hard bounds that keep a hostile or buggy config from becoming a render DoS (SRS 5.2 "sizes bounded"). */
export const LIMITS = {
  maxJsonBytes: 256 * 1024,
  maxJsonDepth: 24,
  maxPages: 20,
  maxSectionsPerPage: 40,
  maxNavItems: 12,
  maxItems: 24,
  maxShortText: 120,
  maxText: 600,
  maxLongText: 3000,
  maxUrl: 2048,
} as const;

// Control characters (except tab/newline/CR) and the bidi override/isolate characters used for spoofing.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/;

/**
 * Plain text. `<` and `>` are rejected outright: no raw HTML can enter the document, so there is nothing for a
 * future renderer mistake to unescape. React still escapes on output (SEC-04); this is the second layer.
 */
export const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !/[<>]/.test(v), { message: 'HTML markup is not allowed in text' })
    .refine((v) => !FORBIDDEN_CHARS.test(v), { message: 'Control characters are not allowed' });

export const shortText = text(LIMITS.maxShortText);
export const mediumText = text(LIMITS.maxText);
export const longText = text(LIMITS.maxLongText);
export const requiredShortText = z.string().min(1).pipe(shortText);

/** Treat the empty string as "unset" (the SRS 5.2 example uses `""` for blanks). */
export const emptyOr = <T extends z.ZodType>(schema: T) => z.union([z.literal(''), schema]);

export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const slug = z.string().regex(SLUG);

/** `https:`, `tel:`, `mailto:` only. `https://wa.me/...` is an https URL. No credentials in the authority. */
export function isSafeUrl(value: string): boolean {
  if (
    value.length > LIMITS.maxUrl ||
    FORBIDDEN_CHARS.test(value) ||
    /\s/.test(value) ||
    /[<>"]/.test(value)
  ) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  switch (url.protocol) {
    case 'https:':
      return url.hostname.length > 0 && url.username === '' && url.password === '';
    case 'tel:':
      return /^tel:\+?[0-9()\-.]{3,30}$/.test(value);
    case 'mailto:':
      return /^mailto:[^?]{3,254}(\?.*)?$/.test(value);
    default:
      return false;
  }
}

export const safeUrl = z
  .string()
  .refine(isSafeUrl, { message: 'Only https:, tel: and mailto: URLs are allowed' });

/** In-site path: `/`, `/about`, `/services/gym`. No `//`, no dots, no query or fragment. */
export const PATH = /^\/$|^(\/[a-z0-9][a-z0-9-]{0,59}){1,4}$/;
export const sitePath = z.string().regex(PATH);

/** A link target is either a page of this site or a safe external URL. */
export const linkTarget = z.union([sitePath, safeUrl]);

export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour such as #E11D2E');

export const phone = emptyOr(z.string().regex(/^\+?[0-9]{8,15}$/, 'Digits only, optional leading +'));
export const email = emptyOr(z.string().max(254).pipe(z.email()));

/** Images only through platform assets (ADR-009); `alt` is mandatory (SRS 5.2). */
export const assetRef = z.strictObject({
  assetId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  alt: z.string().min(1).pipe(text(200)),
});
export type AssetRef = z.infer<typeof assetRef>;

/** Restricted inline rich text as data: bold, italic, link, line break (SRS 5.2). No markup anywhere. */
const richNode = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('text'),
    text: text(LIMITS.maxText),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('link'), text: text(LIMITS.maxShortText), href: linkTarget }),
  z.strictObject({ type: z.literal('br') }),
]);
export const richText = z.array(richNode).max(60);
export type RichText = z.infer<typeof richText>;

export const ACTIONS = ['whatsapp', 'tel', 'mailto', 'link', 'scroll'] as const;

/** A call to action. `whatsapp`/`tel`/`mailto` use the business contact; `link`/`scroll` need a target. */
export const cta = z
  .strictObject({
    label: requiredShortText,
    action: z.enum(ACTIONS),
    target: linkTarget.optional(),
  })
  .refine((c) => (c.action === 'link' || c.action === 'scroll' ? c.target !== undefined : true), {
    message: 'link and scroll actions need a target',
    path: ['target'],
  });
export type Cta = z.infer<typeof cta>;

export const ICONS = [
  'dumbbell',
  'car',
  'heart',
  'star',
  'phone',
  'map-pin',
  'clock',
  'check',
  'shield',
  'camera',
  'music',
  'calendar',
  'users',
  'scissors',
  'utensils',
  'home',
  'book',
  'truck',
  'sparkles',
  'gift',
] as const;
export const icon = z.enum(ICONS);
