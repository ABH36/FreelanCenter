/**
 * Turns a CTA (an action plus the business contact details) into a link, or into `null` when the action cannot work
 * (for example a WhatsApp button on a site with no WhatsApp number). Returning `null` makes blocks omit the button
 * rather than render a dead link. Every href is re-checked against the same rules the schema enforces.
 */
import { ANCHOR, PATH, isSafeUrl, type Cta, type SiteConfig } from '@platform/schema';

export interface ResolvedLink {
  readonly href: string;
  readonly label: string;
  /** Opens another site: callers add `rel="noopener noreferrer"` and `target="_blank"`. */
  readonly external: boolean;
}

const digits = (v: string | undefined) => (v ?? '').replace(/[^0-9]/g, '');

/**
 * Prefixes an in-site link with the base path the site is served under (a preview lives at `/p/<token>`); an anchor on
 * the current page, and anything that is not an in-site path, is left alone.
 */
export function withBase(target: string, basePath = ''): string {
  if (basePath === '' || target.startsWith('#')) return target;
  if (target === '/') return basePath;
  // `/#pricing` is the root page's anchor: `<base>#pricing`, with no trailing slash (the host redirects those).
  if (target.startsWith('/#')) return `${basePath}${target.slice(1)}`;
  return `${basePath}${target}`;
}

export function resolveHref(
  target: string,
  basePath = '',
): { readonly href: string; readonly external: boolean } | null {
  if (PATH.test(target) || ANCHOR.test(target)) return { href: withBase(target, basePath), external: false };
  if (isSafeUrl(target)) return { href: target, external: target.startsWith('https:') };
  return null;
}

export function resolveCta(cta: Cta, business: SiteConfig['business'], basePath = ''): ResolvedLink | null {
  switch (cta.action) {
    case 'whatsapp': {
      const n = digits(business.whatsapp);
      return n.length >= 8 ? { href: `https://wa.me/${n}`, label: cta.label, external: true } : null;
    }
    case 'tel': {
      const n = digits(business.phone || business.whatsapp);
      const raw = business.phone || business.whatsapp || '';
      return n.length >= 8
        ? { href: `tel:${raw.startsWith('+') ? '+' : ''}${n}`, label: cta.label, external: false }
        : null;
    }
    case 'mailto':
      return business.email && isSafeUrl(`mailto:${business.email}`)
        ? { href: `mailto:${business.email}`, label: cta.label, external: false }
        : null;
    case 'link':
    case 'scroll': {
      const r = cta.target ? resolveHref(cta.target, basePath) : null;
      return r ? { ...r, label: cta.label } : null;
    }
  }
}

/** External map link built from coordinates or the address; no third-party embed, no script. */
export function mapHref(business: SiteConfig['business']): string | null {
  const geo = business.address?.geo;
  if (geo && (geo.lat !== 0 || geo.lng !== 0)) {
    return `https://www.google.com/maps/search/?api=1&query=${geo.lat},${geo.lng}`;
  }
  const a = business.address;
  const parts = [business.name, a?.line1, a?.city, a?.state, a?.postalCode].filter(Boolean);
  return a && (a.line1 || a.city)
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(', '))}`
    : null;
}
