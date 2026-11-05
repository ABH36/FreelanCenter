/** Test fixtures only (not exported from the package index). A small but complete valid SiteConfig. */
import type { SiteConfigInput } from './site-config';

export function validConfig(): SiteConfigInput {
  return {
    schemaVersion: '1.0',
    business: {
      name: 'Iron Pulse Fitness',
      category: 'gym',
      tagline: 'Premium weight training in Indore',
      phone: '+919800000000',
      whatsapp: '+919800000000',
      email: 'hello@example.com',
      address: {
        line1: '12 MG Road',
        city: 'Indore',
        state: 'MP',
        postalCode: '452001',
        country: 'IN',
        geo: { lat: 22.7196, lng: 75.8577 },
      },
      hours: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], open: '05:30', close: '22:00' }],
      social: { instagram: 'https://instagram.com/ironpulse', facebook: '', youtube: '' },
    },
    theme: {
      colors: {
        primary: '#E11D2E',
        secondary: '#111827',
        accent: '#FACC15',
        background: '#0B0B0F',
        surface: '#15151C',
        text: '#F9FAFB',
      },
      typography: { heading: 'Poppins', body: 'Inter', scale: 'comfortable' },
      radius: 'lg',
      spacing: 'regular',
      buttons: { style: 'solid', shape: 'pill', hover: 'lift' },
      motion: { preset: 'subtle', reducedMotionRespected: true },
    },
    pages: [
      {
        id: 'home',
        path: '/',
        title: 'Home',
        seo: {
          title: 'Iron Pulse Fitness',
          description: 'Weight training in Indore',
          ogImage: null,
          noindex: false,
        },
        sections: [
          {
            id: 's1',
            type: 'hero',
            variant: 'split-image',
            visible: true,
            props: {
              headline: 'Build strength that lasts',
              subheadline: 'Coaching, equipment and community.',
              primaryCta: { label: 'Join now', action: 'whatsapp' },
              image: { assetId: 'hero-1', alt: 'Members lifting weights' },
            },
            style: { paddingY: 'xl', bg: 'surface' },
            motion: { enter: 'fade-up' },
          },
          {
            id: 's2',
            type: 'services',
            variant: 'cards-3',
            visible: true,
            props: {
              items: [
                {
                  title: 'Personal training',
                  description: 'One to one',
                  price: 'Rs 3000/mo',
                  icon: 'dumbbell',
                },
              ],
            },
          },
          {
            id: 's3',
            type: 'contact',
            variant: 'form-map',
            visible: true,
            props: { fields: ['name', 'phone', 'message'], showMap: true },
          },
        ],
      },
      { id: 'about', path: '/about', title: 'About', sections: [] },
    ],
    navigation: {
      items: [
        { label: 'Home', target: '/' },
        { label: 'About', target: '/about' },
      ],
      cta: { label: 'Call', action: 'tel' },
    },
    footer: { variant: 'simple', showPlatformBadge: true, floatingAction: 'none' },
    integrations: { analyticsId: null, metaPixelId: null, chatbot: { enabled: false } },
  };
}
