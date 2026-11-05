/**
 * Small authoring helpers for built-in templates. They only build plain data; `templateSchema` (tests) is what proves a
 * template valid, so these helpers stay loose on purpose and never import the blocks.
 */
import type { ManifestField } from '@platform/schema';

export interface SectionInput {
  id: string;
  type: string;
  variant: string;
  visible: boolean;
  props: unknown;
  style?: { paddingY?: string; bg?: string };
  motion?: { enter?: string };
}

export function section(
  id: string,
  type: string,
  variant: string,
  props: unknown,
  extra: Pick<SectionInput, 'style' | 'motion'> = {},
): SectionInput {
  return { id, type, variant, visible: true, props, ...extra };
}

export const asset = (assetId: string, alt: string) => ({ assetId, alt });

/** Fixed, obviously fake demo contact details: a preview must never place a call to a real person. */
export const DEMO = {
  phone: '+911234567890',
  whatsapp: '+911234567891',
  email: 'hello@example.com',
} as const;

type Page = { sections: readonly SectionInput[] };

/** Dot path of a prop of a section of a page, resolved against the template as written (no hard-coded indexes). */
export function propPath(pages: readonly Page[], pageIndex: number, sectionId: string, prop: string): string {
  const sections = pages[pageIndex]?.sections ?? [];
  const index = sections.findIndex((s) => s.id === sectionId);
  if (index < 0) throw new Error(`Section "${sectionId}" is not on page ${pageIndex}`);
  return `pages.${pageIndex}.sections.${index}.props.${prop}`;
}

/** The questions every business is asked, mapped to the shared `business` paths (FR-ONB-02). */
export function businessFields(): ManifestField[] {
  return [
    {
      key: 'business-name',
      label: 'Business name',
      kind: 'text',
      path: 'business.name',
      required: true,
      maxLength: 120,
    },
    {
      key: 'logo',
      label: 'Logo',
      kind: 'image',
      path: 'business.logo',
      required: false,
      help: 'A square or wide logo on a plain background works best.',
    },
    {
      key: 'tagline',
      label: 'One line about your business',
      kind: 'text',
      path: 'business.tagline',
      required: false,
      maxLength: 120,
    },
    {
      key: 'phone',
      label: 'Phone number',
      kind: 'phone',
      path: 'business.phone',
      required: true,
      help: 'The number customers call.',
    },
    {
      key: 'whatsapp',
      label: 'WhatsApp number',
      kind: 'phone',
      path: 'business.whatsapp',
      required: true,
      help: 'Include the country code, for example +91.',
    },
    { key: 'email', label: 'Email address', kind: 'email', path: 'business.email', required: false },
    {
      key: 'address-line',
      label: 'Street address',
      kind: 'text',
      path: 'business.address.line1',
      required: true,
      maxLength: 120,
    },
    {
      key: 'city',
      label: 'City',
      kind: 'text',
      path: 'business.address.city',
      required: true,
      maxLength: 120,
    },
    {
      key: 'state',
      label: 'State',
      kind: 'text',
      path: 'business.address.state',
      required: false,
      maxLength: 120,
    },
    {
      key: 'postal-code',
      label: 'PIN code',
      kind: 'text',
      path: 'business.address.postalCode',
      required: false,
      maxLength: 12,
    },
    {
      key: 'opening-hours',
      label: 'Opening hours',
      kind: 'hours',
      path: 'business.hours',
      required: true,
      help: 'Days and times you are open.',
    },
    {
      key: 'instagram',
      label: 'Instagram page',
      kind: 'url',
      path: 'business.social.instagram',
      required: false,
      help: 'The full https:// link.',
    },
    {
      key: 'facebook',
      label: 'Facebook page',
      kind: 'url',
      path: 'business.social.facebook',
      required: false,
    },
    {
      key: 'youtube',
      label: 'YouTube channel',
      kind: 'url',
      path: 'business.social.youtube',
      required: false,
    },
  ];
}
