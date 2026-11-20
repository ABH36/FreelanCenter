/**
 * P3 S9d (DG-40; plan approved by the Owner 2026-11-20): a template's pages come with search titles and
 * descriptions that name the template's demo business ("Iron Pulse Fitness | Gym and personal training"). They do not
 * follow the business name, so a staging or live site could show the demo business in the browser tab and in search
 * results. These pure helpers find such leftovers (for the preflight check) and build the one change that replaces
 * the demo name with the business's own name (for the editor's button). Shared by the server and the browser.
 */
import type { PatchOperation } from './patch';
import type { SiteConfig } from './site-config';

/** The schema limits of `seo.title` and `seo.description`. */
export const SEO_TEXT_LIMITS = { title: 70, description: 200 } as const;

export type SeoTextField = keyof typeof SEO_TEXT_LIMITS;

export interface DemoSeoLeftover {
  pageId: string;
  pageTitle: string;
  fields: SeoTextField[];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The demo name is worth looking for only when it is set and is not part of the business's own name: "Gupta Sweets"
 * in the texts of "Gupta Sweets Indore" may well be the business's short name, and replacing it would double it.
 */
function demoPattern(config: SiteConfig, demoName: string | null | undefined): RegExp | null {
  const demo = demoName?.trim().replace(/\s+/g, ' ');
  if (!demo || demo.length < 3) return null;
  if (norm(config.business.name).includes(norm(demo))) return null;
  return new RegExp(escapeRegExp(demo).replace(/ /g, '\\s+'), 'gi');
}

/** Pages whose search title or description still names the template's demo business. */
export function findDemoSeo(config: SiteConfig, demoName: string | null | undefined): DemoSeoLeftover[] {
  const pattern = demoPattern(config, demoName);
  if (!pattern) return [];
  const found: DemoSeoLeftover[] = [];
  for (const page of config.pages) {
    const fields = (Object.keys(SEO_TEXT_LIMITS) as SeoTextField[]).filter((field) => {
      const text = page.seo?.[field];
      pattern.lastIndex = 0;
      return typeof text === 'string' && pattern.test(text);
    });
    if (fields.length) found.push({ pageId: page.id, pageTitle: page.title, fields });
  }
  return found;
}

/** Cuts a text to `max` characters, at the last word boundary when there is one, without a trailing separator. */
export function clipSeoText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s|,;:–-]+$/u, '');
}

/**
 * One `updatePage` operation per page that names the demo business, replacing it with the business's name and
 * keeping each text within its limit. Empty when there is nothing to replace.
 */
export function replaceDemoSeo(config: SiteConfig, demoName: string | null | undefined): PatchOperation[] {
  const pattern = demoPattern(config, demoName);
  if (!pattern) return [];
  const name = config.business.name.trim();
  const ops: PatchOperation[] = [];
  for (const leftover of findDemoSeo(config, demoName)) {
    const page = config.pages.find((p) => p.id === leftover.pageId);
    if (!page?.seo) continue;
    const seo: { title?: string; description?: string } = {};
    for (const field of leftover.fields) {
      const text = page.seo[field] as string;
      seo[field] = clipSeoText(text.replace(pattern, name), SEO_TEXT_LIMITS[field]);
    }
    ops.push({ op: 'updatePage', pageId: page.id, seo: { ...page.seo, ...seo } } as PatchOperation);
  }
  return ops;
}
