/**
 * Section block catalog: for every section `type`, its closed list of variants and its strict props schema
 * (FR-TPL-01/02). This is the data half of the block registry; `@platform/blocks` (S3) adds components and editor
 * metadata on top, keyed by the same type/variant names. A `type` + `variant` pair that is not listed here is a
 * validation error, never a render-time crash (SRS 5.2).
 *
 * Chrome blocks (header, footer, floating action) are not sections: they are driven by `navigation` and `footer`.
 */
import { z } from 'zod';
import {
  LIMITS,
  assetRef,
  cta,
  icon,
  mediumText,
  requiredShortText,
  richText,
  shortText,
} from './primitives';
import { COLOR_TOKENS } from './theme';

const list = <T extends z.ZodType>(item: T, max: number = LIMITS.maxItems) => z.array(item).max(max);

export const SECTION_PADDING = ['none', 'sm', 'md', 'lg', 'xl'] as const;
export const ENTER_ANIMATIONS = ['none', 'fade-in', 'fade-up', 'slide-left', 'slide-right', 'zoom'] as const;

export const sectionStyle = z.strictObject({
  paddingY: z.enum(SECTION_PADDING).optional(),
  bg: z.enum(['none', ...COLOR_TOKENS]).optional(),
});
export const sectionMotion = z.strictObject({ enter: z.enum(ENTER_ANIMATIONS).optional() });

const heroProps = z.strictObject({
  headline: requiredShortText,
  subheadline: mediumText.optional(),
  primaryCta: cta.optional(),
  secondaryCta: cta.optional(),
  image: assetRef.optional(),
});
const aboutProps = z.strictObject({
  heading: requiredShortText,
  body: richText,
  image: assetRef.optional(),
  highlights: list(requiredShortText, 6).optional(),
});
const servicesProps = z.strictObject({
  heading: shortText.optional(),
  intro: mediumText.optional(),
  items: list(
    z.strictObject({
      title: requiredShortText,
      description: mediumText.optional(),
      price: shortText.optional(),
      icon: icon.optional(),
    }),
    12,
  ),
});
const pricingProps = z.strictObject({
  heading: shortText.optional(),
  intro: mediumText.optional(),
  tiers: list(
    z.strictObject({
      name: requiredShortText,
      price: requiredShortText,
      period: shortText.optional(),
      features: list(requiredShortText, 12),
      highlighted: z.boolean().optional(),
      cta: cta.optional(),
    }),
    6,
  ),
});
const galleryProps = z.strictObject({ heading: shortText.optional(), images: list(assetRef, 24) });
const testimonialsProps = z.strictObject({
  heading: shortText.optional(),
  items: list(
    z.strictObject({
      quote: mediumText.min(1),
      author: requiredShortText,
      role: shortText.optional(),
      rating: z.number().int().min(1).max(5).optional(),
    }),
    12,
  ),
});
const faqProps = z.strictObject({
  heading: shortText.optional(),
  items: list(z.strictObject({ question: requiredShortText, answer: richText }), 20),
});
const teamProps = z.strictObject({
  heading: shortText.optional(),
  members: list(
    z.strictObject({
      name: requiredShortText,
      role: requiredShortText,
      bio: mediumText.optional(),
      image: assetRef.optional(),
    }),
    12,
  ),
});
const statsProps = z.strictObject({
  heading: shortText.optional(),
  items: list(z.strictObject({ value: requiredShortText, label: requiredShortText }), 6),
});
export const CONTACT_FIELDS = ['name', 'phone', 'email', 'message', 'date', 'service'] as const;
const contactProps = z.strictObject({
  heading: shortText.optional(),
  intro: mediumText.optional(),
  fields: z
    .array(z.enum(CONTACT_FIELDS))
    .min(1)
    .max(CONTACT_FIELDS.length)
    .refine((f) => new Set(f).size === f.length, { message: 'Duplicate form field' }),
  showMap: z.boolean().optional(),
});
// No third-party iframe: the map block links out (privacy, performance; SRS 5.2 font/CDN stance).
const mapProps = z.strictObject({ heading: shortText.optional(), note: mediumText.optional() });
const ctaBannerProps = z.strictObject({
  headline: requiredShortText,
  subheadline: mediumText.optional(),
  cta,
});

function block<T extends string, V extends readonly [string, ...string[]], P extends z.ZodType>(
  type: T,
  variants: V,
  props: P,
) {
  return {
    type,
    variants,
    props,
    section: z.strictObject({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
      type: z.literal(type),
      variant: z.enum(variants),
      visible: z.boolean().default(true),
      props,
      style: sectionStyle.optional(),
      motion: sectionMotion.optional(),
    }),
  };
}

export const BLOCKS = {
  hero: block('hero', ['split-image', 'centered', 'full-bleed'], heroProps),
  about: block('about', ['text-image', 'text-only'], aboutProps),
  services: block('services', ['cards-3', 'list', 'icon-grid'], servicesProps),
  pricing: block('pricing', ['tiers', 'table'], pricingProps),
  gallery: block('gallery', ['grid', 'masonry'], galleryProps),
  testimonials: block('testimonials', ['cards', 'single'], testimonialsProps),
  faq: block('faq', ['accordion'], faqProps),
  team: block('team', ['cards'], teamProps),
  stats: block('stats', ['row', 'cards'], statsProps),
  contact: block('contact', ['form-map', 'form-only', 'details'], contactProps),
  map: block('map', ['link-card'], mapProps),
  'cta-banner': block('cta-banner', ['solid', 'split'], ctaBannerProps),
} as const;

export type BlockType = keyof typeof BLOCKS;
export const BLOCK_TYPES = Object.keys(BLOCKS) as BlockType[];

export const sectionSchema = z.discriminatedUnion('type', [
  BLOCKS.hero.section,
  BLOCKS.about.section,
  BLOCKS.services.section,
  BLOCKS.pricing.section,
  BLOCKS.gallery.section,
  BLOCKS.testimonials.section,
  BLOCKS.faq.section,
  BLOCKS.team.section,
  BLOCKS.stats.section,
  BLOCKS.contact.section,
  BLOCKS.map.section,
  BLOCKS['cta-banner'].section,
]);
export type Section = z.infer<typeof sectionSchema>;

/** Does the catalog know this exact pair? Used by the registry consistency test and the patch layer. */
export function hasBlockVariant(type: string, variant: string): boolean {
  if (!Object.hasOwn(BLOCKS, type)) return false;
  return (BLOCKS[type as BlockType].variants as readonly string[]).includes(variant);
}
