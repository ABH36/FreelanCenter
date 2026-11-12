import { DEMO, asset, businessFields, propPath, section } from './helpers';
import type { TemplateDefinition } from './types';

/** Wedding and event planner: warm ivory, maroon and gold with a serif heading, photo-led. Two pages. */
const gallery = (n: number) =>
  Array.from({ length: n }, (_, i) => asset(`wedding-photo-${i + 1}`, `Wedding celebration photo ${i + 1}`));

const home = [
  section(
    'hero',
    'hero',
    'full-bleed',
    {
      headline: 'Your wedding, planned with love',
      subheadline:
        'From the first meeting to the last dance, we design, decorate and run your celebration so your family can enjoy every moment.',
      primaryCta: { label: 'Book a free consultation', action: 'whatsapp' },
      secondaryCta: { label: 'See our work', action: 'link', target: '/gallery' },
      image: asset('wedding-hero', 'A couple during their pheras under a decorated mandap'),
    },
    { style: { paddingY: 'xl', bg: 'surface' } },
  ),
  section(
    'about',
    'about',
    'text-image',
    {
      heading: 'Celebrations that feel like you',
      body: [
        {
          type: 'text',
          text: 'For over a decade we have planned weddings, engagements and family functions across the city. We listen first, then build a plan around your traditions, your guests and your budget.',
        },
      ],
      highlights: [
        'One planner from start to finish',
        'Fixed, written budgets',
        'Trusted vendors for every need',
      ],
      image: asset('wedding-about', 'Planner reviewing a mandap design with a family'),
    },
    { motion: { enter: 'fade-up' } },
  ),
  section(
    'services',
    'services',
    'list',
    {
      heading: 'Everything under one roof',
      items: [
        {
          title: 'Full wedding planning',
          description: 'Timeline, vendors, guests and rituals managed for you.',
        },
        {
          title: 'Decor and mandap design',
          description: 'Floral and theme decor with a 3D preview before you decide.',
        },
        {
          title: 'Catering coordination',
          description: 'Tastings, menus and service staff for every function.',
        },
        {
          title: 'Photography and film',
          description: 'Candid, traditional and cinematic teams of your choice.',
        },
        {
          title: 'Music, DJ and sangeet',
          description: 'Live bands, choreography and sound for the whole week.',
        },
        {
          title: 'Guest hospitality',
          description: 'Hotel blocks, transport and welcome kits for out-of-town guests.',
        },
      ],
    },
    { style: { bg: 'surface' }, motion: { enter: 'fade-up' } },
  ),
  section(
    'work',
    'gallery',
    'grid',
    { heading: 'A few of our celebrations', images: gallery(6) },
    { motion: { enter: 'fade-in' } },
  ),
  section(
    'numbers',
    'stats',
    'row',
    {
      items: [
        { value: '600+', label: 'Weddings planned' },
        { value: '11', label: 'Years of experience' },
        { value: '98%', label: 'Families who recommend us' },
      ],
    },
    { style: { bg: 'secondary' }, motion: { enter: 'fade-up' } },
  ),
  section(
    'review',
    'testimonials',
    'single',
    {
      heading: 'Kind words from families',
      items: [
        {
          quote:
            'They handled three days of functions and 400 guests without a single thing going wrong. We just enjoyed our own wedding.',
          author: 'Aarti and Karan',
          role: 'Married in February',
          rating: 5,
        },
      ],
    },
    { motion: { enter: 'fade-up' } },
  ),
  section(
    'consult',
    'cta-banner',
    'split',
    {
      headline: 'Let us plan your big day',
      subheadline: 'A first consultation is free and has no obligation.',
      cta: { label: 'Book a free consultation', action: 'whatsapp' },
    },
    { style: { paddingY: 'md', bg: 'surface' } },
  ),
  section('contact', 'contact', 'form-map', {
    heading: 'Tell us about your celebration',
    intro: 'Share your date, city and guest count and we will reply within a day.',
    fields: ['name', 'phone', 'date', 'message'],
    showMap: true,
  }),
];

const gallerySections = [
  section(
    'gallery-main',
    'gallery',
    'grid',
    { heading: 'Our work', images: gallery(9) },
    { style: { paddingY: 'xl' } },
  ),
  section(
    'gallery-cta',
    'cta-banner',
    'solid',
    {
      headline: 'Like what you see?',
      subheadline: 'Tell us about your date and we will share ideas that fit your family.',
      cta: { label: 'Book a free consultation', action: 'whatsapp' },
    },
    { style: { paddingY: 'md', bg: 'primary' } },
  ),
];

const pages = [
  {
    id: 'home',
    path: '/',
    title: 'Home',
    seo: {
      title: 'Shubh Vivah Events | Wedding and event planners',
      description:
        'Wedding planning, decor, catering coordination and photography for your family celebration.',
      noindex: false,
    },
    sections: home,
  },
  {
    id: 'gallery',
    path: '/gallery',
    title: 'Gallery',
    seo: {
      title: 'Wedding gallery | Shubh Vivah Events',
      description: 'Photos from weddings and events we have planned.',
      noindex: false,
    },
    sections: gallerySections,
  },
];

export const wedding: TemplateDefinition = {
  id: 'wedding-royal',
  version: 1,
  name: 'Wedding Royal',
  category: 'wedding-event',
  description:
    'An elegant, photo-led two-page site for wedding and event planners, with a hero photo, a gallery page and free-consultation booking on WhatsApp.',
  tags: ['light', 'elegant', 'two-page', 'gallery'],
  config: {
    schemaVersion: '1.0',
    business: {
      name: 'Shubh Vivah Events',
      category: 'wedding-event',
      language: 'en',
      logo: asset('wedding-logo', 'Shubh Vivah Events logo'),
      tagline: 'Weddings and celebrations, planned with love',
      phone: DEMO.phone,
      whatsapp: DEMO.whatsapp,
      email: DEMO.email,
      address: {
        line1: '8 Lake Palace Road',
        city: 'Udaipur',
        state: 'Rajasthan',
        postalCode: '313001',
        country: 'IN',
      },
      hours: [
        { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], open: '10:00', close: '19:00' },
        { days: ['sun'], open: '11:00', close: '15:00' },
      ],
      social: { instagram: '', facebook: '', youtube: '' },
    },
    theme: {
      colors: {
        primary: '#8B1D3B',
        secondary: '#3B0A1E',
        accent: '#9A6B00',
        background: '#FFFBF5',
        surface: '#F7EDE0',
        text: '#2B1416',
      },
      typography: { heading: 'Playfair Display', body: 'Lato', scale: 'spacious' },
      radius: 'sm',
      spacing: 'relaxed',
      buttons: { style: 'solid', shape: 'square', hover: 'glow' },
      motion: { preset: 'subtle', reducedMotionRespected: true },
    },
    pages,
    navigation: {
      items: [
        { label: 'About', target: '/#about' },
        { label: 'Services', target: '/#services' },
        { label: 'Gallery', target: '/gallery' },
        { label: 'Contact', target: '/#contact' },
      ],
      cta: { label: 'Book a free consultation', action: 'whatsapp' },
    },
    footer: { variant: 'columns', showPlatformBadge: true, floatingAction: 'whatsapp' },
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
        help: 'Your most beautiful wedding photo; it fills the top of the site.',
      },
      {
        key: 'services',
        label: 'Services you offer',
        kind: 'list',
        path: propPath(pages, 0, 'services', 'items'),
        required: true,
        maxItems: 8,
        itemFields: [
          { key: 'title', label: 'Service', kind: 'text', required: true, maxLength: 120 },
          { key: 'description', label: 'Details', kind: 'longtext', required: false, maxLength: 600 },
        ],
      },
      {
        key: 'work-photos',
        label: 'Photos of your work',
        kind: 'images',
        path: propPath(pages, 0, 'work', 'images'),
        required: true,
        maxItems: 6,
        help: 'Your six best celebrations.',
      },
      {
        key: 'gallery-photos',
        label: 'Gallery page photos',
        kind: 'images',
        path: propPath(pages, 1, 'gallery-main', 'images'),
        required: false,
        maxItems: 24,
      },
      {
        key: 'reviews',
        label: 'Family reviews',
        kind: 'list',
        path: propPath(pages, 0, 'review', 'items'),
        required: false,
        maxItems: 6,
        itemFields: [
          { key: 'quote', label: 'What they said', kind: 'longtext', required: true, maxLength: 600 },
          { key: 'author', label: 'Names', kind: 'text', required: true, maxLength: 120 },
          { key: 'role', label: 'Occasion', kind: 'text', required: false, maxLength: 120 },
        ],
      },
    ],
  },
};
