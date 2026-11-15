/**
 * P3 S4 (FR-BLD-03): the starting content of a section added in the editor. Approved 2026-11-15: placeholder text
 * rather than empty fields, so the new section shows in the preview at once; S7's preflight warns about placeholder
 * text left before publishing. Every sample is a valid section for every variant of its block (samples.test.ts).
 */
import type { BlockType, Section } from './blocks';

const text = (value: string) => [{ type: 'text' as const, text: value }];

const PROPS: Record<BlockType, Record<string, unknown>> = {
  hero: {
    headline: 'Your headline here',
    subheadline: 'Say what you offer and who it is for.',
    primaryCta: { label: 'Message us', action: 'whatsapp' },
  },
  about: { heading: 'About us', body: text('Tell visitors who you are and what makes you different.') },
  services: { heading: 'Our services', items: [{ title: 'Service name', description: 'What is included.' }] },
  pricing: { heading: 'Prices', tiers: [{ name: 'Basic', price: 'Rs 999', features: ['What is included'] }] },
  gallery: { heading: 'Gallery', images: [] },
  testimonials: {
    heading: 'What customers say',
    items: [{ quote: 'A short quote from a happy customer.', author: 'Customer name' }],
  },
  faq: { heading: 'Questions', items: [{ question: 'A common question?', answer: text('The answer.') }] },
  team: { heading: 'Our team', members: [{ name: 'Team member', role: 'Role' }] },
  stats: { items: [{ value: '10+', label: 'Years of experience' }] },
  contact: { heading: 'Contact us', fields: ['name', 'phone', 'message'] },
  map: { heading: 'Find us' },
  'cta-banner': { headline: 'Ready to start?', cta: { label: 'Message us', action: 'whatsapp' } },
};

/** The placeholder texts above, for S7's preflight ("placeholder text left on the page"). */
export const SAMPLE_TEXTS: readonly string[] = [
  ...new Set(
    JSON.stringify(PROPS)
      .match(
        /"(?:headline|subheadline|heading|title|description|name|role|quote|author|question|text|label)":"([^"]+)"/g,
      )
      ?.map((m) => m.split('":"')[1]!.slice(0, -1)) ?? [],
  ),
];

/** A new, visible section of `type` with placeholder content. The id must be unique in the config. */
export function sampleSection(type: BlockType, variant: string, id: string): Section {
  return {
    id,
    type,
    variant,
    visible: true,
    props: structuredClone(PROPS[type]),
  } as Section;
}
