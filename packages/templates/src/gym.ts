import { DEMO, asset, businessFields, propPath, section } from './helpers';
import type { TemplateDefinition } from './types';

/** Gym and fitness studio: dark, high-contrast, energetic. One long page that sells a free trial. */
const sections = [
  section(
    'hero',
    'hero',
    'split-image',
    {
      headline: 'Build strength that lasts',
      subheadline:
        'Coached training, serious equipment and a community that shows up. Walk in for a free trial class today.',
      primaryCta: { label: 'Book a free trial', action: 'whatsapp' },
      secondaryCta: { label: 'See plans', action: 'scroll', target: '#pricing' },
      image: asset('gym-hero', 'Members training with free weights in a bright gym'),
    },
    { style: { paddingY: 'xl' } },
  ),
  section(
    'numbers',
    'stats',
    'row',
    {
      items: [
        { value: '12+', label: 'Years in the city' },
        { value: '1,500+', label: 'Members trained' },
        { value: '15', label: 'Certified coaches' },
        { value: '4.9', label: 'Average rating' },
      ],
    },
    { style: { paddingY: 'md', bg: 'surface' }, motion: { enter: 'fade-up' } },
  ),
  section(
    'services',
    'services',
    'cards-3',
    {
      heading: 'Train your way',
      intro: 'From first-timers to competitive lifters, there is a programme built for you.',
      items: [
        {
          title: 'Strength and conditioning',
          description: 'Racks, platforms and free weights with a coach on the floor.',
          icon: 'dumbbell',
        },
        {
          title: 'Personal coaching',
          description: 'One to one plans with weekly check-ins and progress tracking.',
          icon: 'users',
        },
        {
          title: 'Group classes',
          description: 'HIIT, functional and mobility classes, morning and evening.',
          icon: 'calendar',
        },
        {
          title: 'Cardio zone',
          description: 'Treadmills, bikes and rowers with a quiet, air-cooled floor.',
          icon: 'heart',
        },
        {
          title: 'Nutrition guidance',
          description: 'Simple Indian meal plans that fit your budget and goal.',
          icon: 'sparkles',
        },
        {
          title: 'Recovery corner',
          description: 'Stretching zone and foam rollers so you come back stronger.',
          icon: 'shield',
        },
      ],
    },
    { motion: { enter: 'fade-up' } },
  ),
  section(
    'about',
    'about',
    'text-image',
    {
      heading: 'A gym that knows your name',
      body: [
        {
          type: 'text',
          text: 'We started with six machines and one rule: nobody trains alone. Today the floor is bigger, but the rule is the same.',
        },
        { type: 'br' },
        {
          type: 'text',
          text: 'Every new member gets a movement check and a plan written by a coach, not a printout.',
        },
      ],
      image: asset('gym-about', 'Coach spotting a member during a squat'),
      highlights: ['Free movement assessment', 'Women-only batches', 'Clean showers and lockers'],
    },
    { style: { bg: 'surface' }, motion: { enter: 'fade-up' } },
  ),
  section(
    'pricing',
    'pricing',
    'tiers',
    {
      heading: 'Simple membership plans',
      intro: 'No joining fee for the first 50 sign-ups this month.',
      tiers: [
        {
          name: 'Monthly',
          price: 'Rs 1,500',
          period: 'month',
          features: ['Full gym access', 'Group classes', 'Locker'],
          cta: { label: 'Choose monthly', action: 'whatsapp' },
        },
        {
          name: 'Quarterly',
          price: 'Rs 3,900',
          period: '3 months',
          features: ['Everything in Monthly', 'Two coaching sessions', 'Diet chart'],
          highlighted: true,
          cta: { label: 'Choose quarterly', action: 'whatsapp' },
        },
        {
          name: 'Annual',
          price: 'Rs 12,000',
          period: 'year',
          features: ['Everything in Quarterly', 'Monthly body scan', 'Guest passes'],
          cta: { label: 'Choose annual', action: 'whatsapp' },
        },
      ],
    },
    { motion: { enter: 'fade-up' } },
  ),
  section(
    'team',
    'team',
    'cards',
    {
      heading: 'Meet your coaches',
      members: [
        {
          name: 'Rohit Sharma',
          role: 'Head coach, strength',
          bio: 'National-level powerlifter with ten years of coaching.',
          image: asset('gym-coach-1', 'Rohit, head strength coach'),
        },
        {
          name: 'Neha Verma',
          role: 'Group classes and mobility',
          bio: 'Runs the morning HIIT and the women-only batches.',
          image: asset('gym-coach-2', 'Neha, group class coach'),
        },
        {
          name: 'Imran Khan',
          role: 'Nutrition and fat loss',
          bio: 'Builds practical meal plans around home food.',
          image: asset('gym-coach-3', 'Imran, nutrition coach'),
        },
      ],
    },
    { style: { bg: 'surface' }, motion: { enter: 'fade-up' } },
  ),
  section(
    'reviews',
    'testimonials',
    'cards',
    {
      heading: 'What members say',
      items: [
        {
          quote:
            'I lost 14 kg in five months and never felt lost on the floor. The coaches actually check on you.',
          author: 'Ankit J.',
          role: 'Member since 2023',
          rating: 5,
        },
        {
          quote: 'The women-only morning batch made it easy for me to start. Clean, safe and friendly.',
          author: 'Pooja S.',
          role: 'Member since 2024',
          rating: 5,
        },
        {
          quote: 'Best equipment in the area and the plans are honest, no pushy selling.',
          author: 'Dev K.',
          role: 'Member since 2022',
          rating: 5,
        },
      ],
    },
    { motion: { enter: 'fade-up' } },
  ),
  section(
    'questions',
    'faq',
    'accordion',
    {
      heading: 'Questions before you join',
      items: [
        {
          question: 'Can I try before I pay?',
          answer: [
            {
              type: 'text',
              text: 'Yes. Your first class is free, and we will show you around without any pressure.',
            },
          ],
        },
        {
          question: 'I have never trained. Is that fine?',
          answer: [
            {
              type: 'text',
              text: 'Most members start from zero. A coach builds your first plan and stays with you for the first two weeks.',
            },
          ],
        },
        {
          question: 'Do you have parking and changing rooms?',
          answer: [
            { type: 'text', text: 'Yes, free two-wheeler parking, lockers and separate changing rooms.' },
          ],
        },
        {
          question: 'Can I pause my membership?',
          answer: [
            {
              type: 'text',
              text: 'Quarterly and annual members can pause for up to 30 days for travel or illness.',
            },
          ],
        },
      ],
    },
    { style: { bg: 'surface' } },
  ),
  section(
    'trial',
    'cta-banner',
    'split',
    {
      headline: 'Your first class is on us',
      subheadline: 'Message us on WhatsApp and pick a time that suits you.',
      cta: { label: 'Claim free trial', action: 'whatsapp' },
    },
    { style: { paddingY: 'md', bg: 'primary' } },
  ),
  section('contact', 'contact', 'form-map', {
    heading: 'Visit or message us',
    intro: 'We reply on WhatsApp within the hour during opening times.',
    fields: ['name', 'phone', 'message'],
    showMap: true,
  }),
];

const pages = [
  {
    id: 'home',
    path: '/',
    title: 'Home',
    seo: {
      title: 'Iron Pulse Fitness | Gym and personal training',
      description: 'Strength training, group classes and personal coaching with a free first class.',
      noindex: false,
    },
    sections,
  },
];

export const gym: TemplateDefinition = {
  id: 'gym-bold',
  version: 1,
  name: 'Gym Bold',
  category: 'gym',
  description:
    'A dark, high-energy one-page site for gyms and fitness studios that sells a free trial and shows plans.',
  tags: ['dark', 'bold', 'one-page', 'bilingual-ready'],
  config: {
    schemaVersion: '1.0',
    business: {
      name: 'Iron Pulse Fitness',
      category: 'gym',
      language: 'en',
      logo: asset('gym-logo', 'Iron Pulse Fitness logo'),
      tagline: 'Strength training and coaching',
      phone: DEMO.phone,
      whatsapp: DEMO.whatsapp,
      email: DEMO.email,
      address: {
        line1: '12 MG Road',
        city: 'Indore',
        state: 'Madhya Pradesh',
        postalCode: '452001',
        country: 'IN',
      },
      hours: [
        { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], open: '05:30', close: '22:00' },
        { days: ['sun'], open: '07:00', close: '12:00' },
      ],
      social: { instagram: 'https://instagram.com/example', facebook: '', youtube: '' },
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
      motion: { preset: 'energetic', reducedMotionRespected: true },
    },
    pages,
    navigation: {
      items: [
        { label: 'About', target: '/#about' },
        { label: 'Services', target: '/#services' },
        { label: 'Pricing', target: '/#pricing' },
        { label: 'Contact', target: '/#contact' },
      ],
      cta: { label: 'Free trial', action: 'whatsapp' },
    },
    footer: { variant: 'columns', showPlatformBadge: true, floatingAction: 'both' },
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
        help: 'The first thing visitors read.',
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
        help: 'A bright photo of your gym floor.',
      },
      {
        key: 'services',
        label: 'Your programmes',
        kind: 'list',
        path: propPath(pages, 0, 'services', 'items'),
        required: true,
        maxItems: 6,
        itemFields: [
          { key: 'title', label: 'Programme name', kind: 'text', required: true, maxLength: 120 },
          {
            key: 'description',
            label: 'What members get',
            kind: 'longtext',
            required: false,
            maxLength: 600,
          },
        ],
      },
      {
        key: 'plans',
        label: 'Membership plans',
        kind: 'list',
        path: propPath(pages, 0, 'pricing', 'tiers'),
        required: true,
        maxItems: 4,
        itemFields: [
          { key: 'name', label: 'Plan name', kind: 'text', required: true, maxLength: 120 },
          { key: 'price', label: 'Price', kind: 'text', required: true, maxLength: 120 },
          { key: 'period', label: 'Per', kind: 'text', required: false, maxLength: 120 },
        ],
      },
      {
        key: 'coaches',
        label: 'Your coaches',
        kind: 'list',
        path: propPath(pages, 0, 'team', 'members'),
        required: false,
        maxItems: 6,
        itemFields: [
          { key: 'name', label: 'Name', kind: 'text', required: true, maxLength: 120 },
          { key: 'role', label: 'Speciality', kind: 'text', required: true, maxLength: 120 },
          { key: 'bio', label: 'About them', kind: 'longtext', required: false, maxLength: 600 },
        ],
      },
      {
        key: 'reviews',
        label: 'Member reviews',
        kind: 'list',
        path: propPath(pages, 0, 'reviews', 'items'),
        required: false,
        maxItems: 6,
        itemFields: [
          { key: 'quote', label: 'What they said', kind: 'longtext', required: true, maxLength: 600 },
          { key: 'author', label: 'Name', kind: 'text', required: true, maxLength: 120 },
          { key: 'role', label: 'Since', kind: 'text', required: false, maxLength: 120 },
        ],
      },
    ],
  },
};
