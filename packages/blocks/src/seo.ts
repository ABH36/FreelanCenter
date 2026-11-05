/**
 * SEO documents derived from a validated SiteConfig (FR-TPL-03 SEO-ready): schema.org JSON-LD, sitemap.xml and
 * robots.txt. Pure string builders; every dynamic value is escaped for the context it lands in.
 */
import type { Category, SiteConfig } from '@platform/schema';

export const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** JSON that is safe inside a `<script type="application/ld+json">` element: nothing can close the element. */
export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** schema.org type per template category. Unknown or generic categories fall back to `LocalBusiness`. */
export const SCHEMA_ORG_TYPE: Record<Category, string> = {
  gym: 'ExerciseGym',
  taxi: 'TaxiService',
  'wedding-event': 'LocalBusiness',
  distributor: 'LocalBusiness',
  salon: 'BeautySalon',
  clinic: 'MedicalClinic',
  restaurant: 'Restaurant',
  coaching: 'EducationalOrganization',
  'real-estate': 'RealEstateAgent',
  generic: 'LocalBusiness',
};

const DAY_NAME = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
} as const;

export function localBusinessJsonLd(
  config: SiteConfig,
  origin: string,
  imageUrl: string | null,
  logoUrl: string | null = null,
): Record<string, unknown> {
  const b = config.business;
  const a = b.address;
  const out: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': SCHEMA_ORG_TYPE[b.category],
    name: b.name,
    url: `${origin}/`,
    inLanguage: b.language,
  };
  if (b.tagline) out['description'] = b.tagline;
  if (imageUrl) out['image'] = imageUrl;
  if (logoUrl) out['logo'] = logoUrl;
  if (b.phone) out['telephone'] = b.phone;
  if (b.email) out['email'] = b.email;
  if (a && (a.line1 || a.city || a.state || a.postalCode)) {
    out['address'] = {
      '@type': 'PostalAddress',
      ...(a.line1 ? { streetAddress: a.line1 } : {}),
      ...(a.city ? { addressLocality: a.city } : {}),
      ...(a.state ? { addressRegion: a.state } : {}),
      ...(a.postalCode ? { postalCode: a.postalCode } : {}),
      ...(a.country ? { addressCountry: a.country } : {}),
    };
  }
  if (a?.geo && (a.geo.lat !== 0 || a.geo.lng !== 0)) {
    out['geo'] = { '@type': 'GeoCoordinates', latitude: a.geo.lat, longitude: a.geo.lng };
  }
  if (b.hours?.length) {
    out['openingHoursSpecification'] = b.hours.map((h) => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: h.days.map((d) => DAY_NAME[d]),
      opens: h.open,
      closes: h.close,
    }));
  }
  const sameAs = Object.values(b.social ?? {}).filter((u): u is string => typeof u === 'string' && u !== '');
  if (sameAs.length) out['sameAs'] = sameAs;
  return out;
}

const xml = (s: string) => escapeHtml(s);

/** URL of a page on this origin. `/` is the origin root. */
export const pageUrl = (origin: string, path: string): string =>
  path === '/' ? `${origin}/` : `${origin}${path}`;

/** sitemap.xml for the indexable pages (those without `seo.noindex`). */
export function buildSitemap(config: SiteConfig, origin: string, lastModified?: Date): string {
  const lastmod = lastModified && !Number.isNaN(lastModified.getTime()) ? lastModified.toISOString() : null;
  const urls = config.pages
    .filter((p) => !p.seo?.noindex)
    .map(
      (p) =>
        `<url><loc>${xml(pageUrl(origin, p.path))}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`;
}

/** robots.txt: crawlable public sites point at the sitemap; everything else is disallowed. */
export function buildRobots(origin: string, indexable: boolean): string {
  return indexable
    ? `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`
    : 'User-agent: *\nDisallow: /\n';
}
