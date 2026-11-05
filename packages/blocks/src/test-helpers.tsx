/** Test helpers (not exported from the package index). */
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { parseSiteConfig, type Section, type SiteConfig, type SiteConfigInput } from '@platform/schema';
import { createContext, type RenderContext } from './context';
import { registry } from './registry';

export function baseConfig(sections: unknown[] = [], extra: Partial<SiteConfigInput> = {}): SiteConfigInput {
  return {
    schemaVersion: '1.0',
    business: {
      name: 'Iron Pulse Fitness',
      category: 'gym',
      language: 'en',
      tagline: 'Premium weight training in Indore',
      phone: '+919800000000',
      whatsapp: '+919800000001',
      email: 'hello@example.com',
      address: { line1: '12 MG Road', city: 'Indore', state: 'MP', postalCode: '452001', country: 'IN' },
      hours: [{ days: ['mon', 'tue'], open: '05:30', close: '22:00' }],
      social: { instagram: 'https://instagram.com/ironpulse' },
    },
    theme: {
      colors: {
        primary: '#1D4ED8',
        secondary: '#111827',
        accent: '#B45309',
        background: '#FFFFFF',
        surface: '#F3F4F6',
        text: '#111827',
      },
      typography: { heading: 'Poppins', body: 'Inter', scale: 'comfortable' },
      radius: 'md',
      spacing: 'regular',
      buttons: { style: 'solid', shape: 'rounded', hover: 'lift' },
      motion: { preset: 'subtle', reducedMotionRespected: true },
    },
    pages: [{ id: 'home', path: '/', title: 'Home', sections: sections as never }],
    navigation: { items: [{ label: 'Home', target: '/' }], cta: { label: 'Call', action: 'tel' } },
    footer: { variant: 'simple', showPlatformBadge: true, floatingAction: 'both' },
    integrations: {},
    ...extra,
  };
}

export function parsed(input: SiteConfigInput): SiteConfig {
  const r = parseSiteConfig(input);
  if (!r.ok) throw new Error(`fixture invalid: ${JSON.stringify(r.issues)}`);
  return r.config;
}

export function ctxFor(config: SiteConfig, overrides: Partial<RenderContext> = {}): RenderContext {
  return createContext(config, overrides);
}

/** One section per built-in (type, variant) with the block's own default content. */
export function allDefaultSections(): Section[] {
  const out: unknown[] = [];
  let n = 0;
  for (const def of registry.list()) {
    for (const v of def.variants) {
      out.push({
        id: `s${(n += 1)}`,
        type: def.type,
        variant: v.id,
        visible: true,
        props: def.defaults(v.id),
      });
    }
  }
  return out as Section[];
}

export const html = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
