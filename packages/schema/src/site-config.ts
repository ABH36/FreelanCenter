/** SiteConfig v1.0 (SRS 5.2): the one document shared by DB, AI, builder and renderer. */
import { z } from 'zod';
import { sectionSchema } from './blocks';
import {
  LIMITS,
  assetRef,
  cta,
  email,
  emptyOr,
  linkTarget,
  phone,
  requiredShortText,
  safeUrl,
  shortText,
  sitePath,
  slug,
  text,
} from './primitives';
import { themeSchema } from './theme';

export const SCHEMA_VERSION = '1.0' as const;

export const CATEGORIES = [
  'gym',
  'taxi',
  'wedding-event',
  'distributor',
  'salon',
  'clinic',
  'restaurant',
  'coaching',
  'real-estate',
  'generic',
] as const;
export type Category = (typeof CATEGORIES)[number];

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const businessSchema = z.strictObject({
  name: requiredShortText,
  category: z.enum(CATEGORIES),
  // Not in the SRS 5.2 sample: the site's language, for <html lang> and the blocks' fixed UI strings (P2 S3).
  language: z.enum(['en', 'hi']).default('en'),
  tagline: shortText.optional(),
  phone: phone.optional(),
  whatsapp: phone.optional(),
  email: email.optional(),
  address: z
    .strictObject({
      line1: shortText.optional(),
      city: shortText.optional(),
      state: shortText.optional(),
      postalCode: text(12).optional(),
      country: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .optional(),
      geo: z
        .strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
        .optional(),
    })
    .optional(),
  hours: z
    .array(
      z.strictObject({
        days: z.array(z.enum(DAYS)).min(1).max(7),
        open: time,
        close: time,
      }),
    )
    .max(14)
    .optional(),
  social: z
    .strictObject({
      instagram: emptyOr(safeUrl).optional(),
      facebook: emptyOr(safeUrl).optional(),
      youtube: emptyOr(safeUrl).optional(),
    })
    .optional(),
});

const seoSchema = z.strictObject({
  title: text(70).optional(),
  description: text(200).optional(),
  ogImage: assetRef.nullable().optional(),
  noindex: z.boolean().default(false),
});

const pageSchema = z.strictObject({
  id: slug,
  path: sitePath,
  title: requiredShortText,
  seo: seoSchema.optional(),
  sections: z.array(sectionSchema).max(LIMITS.maxSectionsPerPage),
});

export const footerSchema = z.strictObject({
  variant: z.enum(['simple', 'columns']),
  showPlatformBadge: z.boolean(),
  // Not in the SRS 5.2 sample JSON: floating WhatsApp/call button (FR-TPL-02) needs a home. Optional, default off.
  floatingAction: z.enum(['none', 'whatsapp', 'call', 'both']).default('none'),
});

export const siteConfigSchema = z
  .strictObject({
    schemaVersion: z.literal('1.0'),
    business: businessSchema,
    theme: themeSchema,
    pages: z.array(pageSchema).min(1).max(LIMITS.maxPages),
    navigation: z.strictObject({
      items: z
        .array(z.strictObject({ label: requiredShortText, target: linkTarget }))
        .max(LIMITS.maxNavItems),
      cta: cta.optional(),
    }),
    footer: footerSchema,
    integrations: z.strictObject({
      analyticsId: text(40).nullable().optional(),
      metaPixelId: text(40).nullable().optional(),
      chatbot: z.strictObject({ enabled: z.boolean() }).optional(),
    }),
  })
  .superRefine((config, ctx) => {
    const pageIds = new Set<string>();
    const paths = new Set<string>();
    const sectionIds = new Set<string>();
    config.pages.forEach((page, p) => {
      if (pageIds.has(page.id))
        ctx.addIssue({ code: 'custom', path: ['pages', p, 'id'], message: 'Duplicate page id' });
      if (paths.has(page.path))
        ctx.addIssue({ code: 'custom', path: ['pages', p, 'path'], message: 'Duplicate page path' });
      pageIds.add(page.id);
      paths.add(page.path);
      page.sections.forEach((section, s) => {
        if (sectionIds.has(section.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['pages', p, 'sections', s, 'id'],
            message: 'Duplicate section id',
          });
        }
        sectionIds.add(section.id);
      });
    });
    if (!paths.has('/'))
      ctx.addIssue({ code: 'custom', path: ['pages'], message: 'A page with path "/" is required' });
    const sectionsByPath = new Map(
      config.pages.map((pg) => [pg.path, new Set(pg.sections.map((sec) => sec.id))]),
    );
    config.navigation.items.forEach((item, i) => {
      if (!item.target.startsWith('/') && !item.target.startsWith('#')) return; // external URL
      const [base = '', anchor] = item.target.split('#');
      const pagePath = base === '' ? '/' : base;
      const sections = sectionsByPath.get(pagePath);
      const message = !sections
        ? 'Navigation target is not a page'
        : anchor !== undefined && !sections.has(anchor)
          ? 'Navigation anchor is not a section of that page'
          : null;
      if (message) ctx.addIssue({ code: 'custom', path: ['navigation', 'items', i, 'target'], message });
    });
  });

export type SiteConfig = z.infer<typeof siteConfigSchema>;
export type SiteConfigInput = z.input<typeof siteConfigSchema>;
