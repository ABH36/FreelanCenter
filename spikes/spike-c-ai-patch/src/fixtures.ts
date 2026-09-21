import type { SiteConfig } from './patch.ts';

/** A small but realistic draft used by tests and the live run. */
export const GYM_CONFIG: SiteConfig = {
  schemaVersion: '1.0',
  business: {
    name: 'Iron Pulse Fitness',
    category: 'gym',
    city: 'Indore',
    tagline: 'Premium weight training',
    phone: '+919800000000',
  },
  theme: {
    colors: {
      primary: '#2563EB',
      secondary: '#111827',
      accent: '#F59E0B',
      background: '#FFFFFF',
      text: '#0F172A',
    },
    motion: 'subtle',
  },
  pages: [
    {
      id: 'home',
      path: '/',
      title: 'Home',
      seo: { title: 'Iron Pulse Fitness', description: 'Gym in Indore' },
      sections: [
        {
          id: 'hero',
          type: 'hero',
          variant: 'split-image',
          visible: true,
          props: {
            headline: 'Train harder',
            subheadline: 'Modern equipment and coaches',
            ctaLabel: 'Join now',
          },
        },
        {
          id: 'services',
          type: 'services',
          variant: 'cards-3',
          visible: true,
          props: { items: [{ title: 'Personal training', description: 'One-on-one coaching' }] },
        },
        {
          id: 'pricing',
          type: 'pricing',
          variant: 'columns',
          visible: true,
          props: { plans: [{ name: 'Monthly', price: 'Rs 1500', features: ['All equipment'] }] },
        },
        {
          id: 'contact',
          type: 'contact',
          variant: 'form-map',
          visible: true,
          props: { heading: 'Visit us', fields: ['name', 'phone', 'message'] },
        },
      ],
    },
  ],
};
