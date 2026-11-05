import { DEMO, asset, businessFields, propPath, section } from './helpers';
import type { TemplateDefinition } from './types';

/** Taxi and cab service: bright yellow on deep navy, built to get a booking by call or WhatsApp in one tap. Two pages. */
const home = [
  section(
    'hero',
    'hero',
    'full-bleed',
    {
      headline: 'Reliable cabs, on time, every time',
      subheadline:
        'Airport transfers, city rides and outstation trips with clean cars and verified drivers. Fixed fares, no surprises.',
      primaryCta: { label: 'Book on WhatsApp', action: 'whatsapp' },
      secondaryCta: { label: 'Call now', action: 'tel' },
      image: asset('taxi-hero', 'A clean white sedan waiting at a city pickup point'),
    },
    { style: { paddingY: 'xl' } },
  ),
  section(
    'trust',
    'stats',
    'cards',
    {
      items: [
        { value: '24x7', label: 'Booking and support' },
        { value: '15,000+', label: 'Trips completed' },
        { value: '4.8', label: 'Rider rating' },
      ],
    },
    { style: { paddingY: 'md' }, motion: { enter: 'fade-up' } },
  ),
  section(
    'services',
    'services',
    'icon-grid',
    {
      heading: 'Where would you like to go?',
      items: [
        {
          title: 'City rides',
          description: 'Hourly and point-to-point rides inside the city.',
          icon: 'map-pin',
        },
        {
          title: 'Airport transfers',
          description: 'Flight-tracked pickups and drops, any hour.',
          icon: 'car',
        },
        {
          title: 'Outstation trips',
          description: 'One way and round trip with experienced highway drivers.',
          icon: 'truck',
        },
        {
          title: 'Tour packages',
          description: 'Multi-day family tours with a fixed itinerary and fare.',
          icon: 'calendar',
        },
        {
          title: 'Weddings and events',
          description: 'Decorated cars and guest shuttles for your big day.',
          icon: 'gift',
        },
        {
          title: 'Corporate travel',
          description: 'Monthly billing and GST invoices for your team.',
          icon: 'users',
        },
      ],
    },
    { style: { bg: 'surface' }, motion: { enter: 'fade-up' } },
  ),
  section(
    'about',
    'about',
    'text-image',
    {
      heading: 'Drivers you can trust',
      body: [
        {
          type: 'text',
          text: 'Every driver is background-checked, trained and paid fairly, so you get a calm, safe ride. Our cars are cleaned before every trip and serviced on schedule.',
        },
      ],
      highlights: [
        'Verified drivers and cars',
        'Fixed fares, no hidden charges',
        'Live trip details on WhatsApp',
      ],
      image: asset('taxi-about', 'Driver helping a guest load luggage into a cab'),
    },
    { motion: { enter: 'fade-up' } },
  ),
  section(
    'review',
    'testimonials',
    'single',
    {
      heading: 'Riders recommend us',
      items: [
        {
          quote:
            'Early morning flight, cab was at my gate ten minutes before time. Driver helped with all the bags. Will book again.',
          author: 'Meera T.',
          role: 'Airport transfer',
          rating: 5,
        },
      ],
    },
    { style: { bg: 'surface' }, motion: { enter: 'fade-up' } },
  ),
  section(
    'book',
    'cta-banner',
    'solid',
    {
      headline: 'Need a cab right now?',
      subheadline: 'Message your pickup and drop. We confirm the fare in minutes.',
      cta: { label: 'Book on WhatsApp', action: 'whatsapp' },
    },
    { style: { paddingY: 'md', bg: 'primary' } },
  ),
  section('contact', 'contact', 'details', {
    heading: 'Talk to us',
    intro: 'Call or message any time. Our desk never closes.',
    fields: ['name', 'phone'],
    showMap: true,
  }),
];

const rates = [
  section(
    'rate-card',
    'pricing',
    'table',
    {
      heading: 'Our rates',
      intro:
        'Per-kilometre rates for outstation trips. City and airport fares are fixed by route; ask us for a quote.',
      tiers: [
        { name: 'Hatchback', price: 'Rs 11', period: 'km', features: ['4 seats', 'AC', 'Small luggage'] },
        { name: 'Sedan', price: 'Rs 13', period: 'km', features: ['4 seats', 'AC', 'Large boot'] },
        {
          name: 'SUV',
          price: 'Rs 18',
          period: 'km',
          features: ['6 to 7 seats', 'AC', 'Roof carrier on request'],
        },
      ],
    },
    { style: { paddingY: 'xl' } },
  ),
  section(
    'rate-faq',
    'faq',
    'accordion',
    {
      heading: 'Before you book',
      items: [
        {
          question: 'Are tolls and parking included?',
          answer: [
            {
              type: 'text',
              text: 'Tolls, parking and state taxes are charged as per actual and shown on the receipt.',
            },
          ],
        },
        {
          question: 'What if my flight is delayed?',
          answer: [{ type: 'text', text: 'We track your flight and adjust the pickup time at no charge.' }],
        },
        {
          question: 'How do I pay?',
          answer: [
            { type: 'text', text: 'UPI, cash or card on board. Corporate accounts get monthly invoices.' },
          ],
        },
      ],
    },
    { style: { bg: 'surface' } },
  ),
  section(
    'rate-cta',
    'cta-banner',
    'split',
    { headline: 'Get your fare in minutes', cta: { label: 'Ask on WhatsApp', action: 'whatsapp' } },
    { style: { paddingY: 'md' } },
  ),
];

const pages = [
  {
    id: 'home',
    path: '/',
    title: 'Home',
    seo: {
      title: 'QuickRide Cabs | Airport, city and outstation taxi',
      description:
        'Book reliable cabs for airport transfers, city rides and outstation trips with fixed fares.',
      noindex: false,
    },
    sections: home,
  },
  {
    id: 'rates',
    path: '/rates',
    title: 'Rates',
    seo: {
      title: 'Cab rates per km | QuickRide Cabs',
      description: 'Per-kilometre taxi rates for hatchback, sedan and SUV.',
      noindex: false,
    },
    sections: rates,
  },
];

export const taxi: TemplateDefinition = {
  id: 'taxi-quick',
  version: 1,
  name: 'Taxi Quick',
  category: 'taxi',
  description:
    'A bright, fast two-page site for taxi and cab services with a rate card and one-tap WhatsApp booking.',
  tags: ['dark', 'yellow', 'two-page', 'booking'],
  config: {
    schemaVersion: '1.0',
    business: {
      name: 'QuickRide Cabs',
      category: 'taxi',
      language: 'en',
      logo: asset('taxi-logo', 'QuickRide Cabs logo'),
      tagline: 'Airport, city and outstation cabs',
      phone: DEMO.phone,
      whatsapp: DEMO.whatsapp,
      email: DEMO.email,
      address: {
        line1: '5 Station Road',
        city: 'Jaipur',
        state: 'Rajasthan',
        postalCode: '302006',
        country: 'IN',
      },
      hours: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], open: '00:00', close: '23:59' }],
      social: { instagram: '', facebook: 'https://facebook.com/example', youtube: '' },
    },
    theme: {
      colors: {
        primary: '#FACC15',
        secondary: '#0B1220',
        accent: '#FDE68A',
        background: '#0F172A',
        surface: '#1E293B',
        text: '#F8FAFC',
      },
      typography: { heading: 'Montserrat', body: 'Open Sans', scale: 'comfortable' },
      radius: 'md',
      spacing: 'regular',
      buttons: { style: 'solid', shape: 'rounded', hover: 'darken' },
      motion: { preset: 'subtle', reducedMotionRespected: true },
    },
    pages,
    navigation: {
      items: [
        { label: 'Services', target: '/#services' },
        { label: 'Rates', target: '/rates' },
        { label: 'Contact', target: '/#contact' },
      ],
      cta: { label: 'Call now', action: 'tel' },
    },
    footer: { variant: 'simple', showPlatformBadge: true, floatingAction: 'both' },
    integrations: {},
  },
  manifest: {
    fields: [
      ...businessFields(),
      {
        key: 'headline',
        label: 'Main headline',
        kind: 'text',
        path: propPath(pages, 0, 'hero', 'headline'),
        required: true,
        maxLength: 120,
      },
      {
        key: 'intro',
        label: 'Short introduction',
        kind: 'longtext',
        path: propPath(pages, 0, 'hero', 'subheadline'),
        required: false,
        maxLength: 600,
      },
      {
        key: 'hero-photo',
        label: 'Main photo',
        kind: 'image',
        path: propPath(pages, 0, 'hero', 'image'),
        required: false,
        help: 'Your best-looking car in good light.',
      },
      {
        key: 'services',
        label: 'Services you offer',
        kind: 'list',
        path: propPath(pages, 0, 'services', 'items'),
        required: true,
        maxItems: 6,
        itemFields: [
          { key: 'title', label: 'Service', kind: 'text', required: true, maxLength: 120 },
          { key: 'description', label: 'Details', kind: 'longtext', required: false, maxLength: 600 },
        ],
      },
      {
        key: 'rates',
        label: 'Rate card',
        kind: 'list',
        path: propPath(pages, 1, 'rate-card', 'tiers'),
        required: true,
        maxItems: 6,
        itemFields: [
          { key: 'name', label: 'Vehicle type', kind: 'text', required: true, maxLength: 120 },
          { key: 'price', label: 'Rate', kind: 'text', required: true, maxLength: 120 },
          { key: 'period', label: 'Per', kind: 'text', required: false, maxLength: 120 },
        ],
      },
      {
        key: 'reviews',
        label: 'Rider reviews',
        kind: 'list',
        path: propPath(pages, 0, 'review', 'items'),
        required: false,
        maxItems: 6,
        itemFields: [
          { key: 'quote', label: 'What they said', kind: 'longtext', required: true, maxLength: 600 },
          { key: 'author', label: 'Name', kind: 'text', required: true, maxLength: 120 },
        ],
      },
    ],
  },
};
