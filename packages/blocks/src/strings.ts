/**
 * Fixed interface strings of the blocks (button captions, form labels, screen-reader text). Business content is
 * never here: it comes from the config. A site is monolingual in P2 (`business.language`); a language switcher and
 * per-page translations are NFR-I18N-01 (P5).
 */
export type Locale = 'en' | 'hi';

const en = {
  recommended: 'Recommended',
  plan: 'Plan',
  price: 'Price',
  included: 'Included',
  openInMaps: 'Open in Maps',
  opensNewTab: '(opens in a new tab)',
  sendMessage: 'Send message',
  whatsappUs: 'WhatsApp us',
  callNow: 'Call now',
  menu: 'Menu',
  skipToContent: 'Skip to main content',
  mainNavigation: 'Main navigation',
  footerNavigation: 'Footer navigation',
  starsOutOf5: '{n} out of 5 stars',
  to: 'to',
  hours: 'Opening hours',
  follow: 'Follow us',
  fieldName: 'Your name',
  fieldPhone: 'Phone number',
  fieldEmail: 'Email address',
  fieldMessage: 'Message',
  fieldDate: 'Preferred date',
  fieldService: 'Service you need',
  dayMon: 'Mon',
  dayTue: 'Tue',
  dayWed: 'Wed',
  dayThu: 'Thu',
  dayFri: 'Fri',
  daySat: 'Sat',
  daySun: 'Sun',
  floatingWhatsapp: 'Chat on WhatsApp',
  floatingCall: 'Call us',
  blockUnavailable: 'This section could not be displayed.',
  notFoundTitle: 'Page not found',
  notFoundText: 'The page you are looking for does not exist or has moved.',
  backHome: 'Back to the home page',
} as const;

export type StringKey = keyof typeof en;

const hi: Record<StringKey, string> = {
  recommended: 'अनुशंसित',
  plan: 'प्लान',
  price: 'कीमत',
  included: 'शामिल',
  openInMaps: 'मैप में खोलें',
  opensNewTab: '(नए टैब में खुलता है)',
  sendMessage: 'संदेश भेजें',
  whatsappUs: 'WhatsApp करें',
  callNow: 'अभी कॉल करें',
  menu: 'मेनू',
  skipToContent: 'मुख्य सामग्री पर जाएँ',
  mainNavigation: 'मुख्य नेविगेशन',
  footerNavigation: 'फ़ुटर नेविगेशन',
  starsOutOf5: '5 में से {n} स्टार',
  to: 'से',
  hours: 'खुलने का समय',
  follow: 'हमें फ़ॉलो करें',
  fieldName: 'आपका नाम',
  fieldPhone: 'फ़ोन नंबर',
  fieldEmail: 'ईमेल पता',
  fieldMessage: 'संदेश',
  fieldDate: 'पसंदीदा तारीख़',
  fieldService: 'आपको कौन सी सेवा चाहिए',
  dayMon: 'सोम',
  dayTue: 'मंगल',
  dayWed: 'बुध',
  dayThu: 'गुरु',
  dayFri: 'शुक्र',
  daySat: 'शनि',
  daySun: 'रवि',
  floatingWhatsapp: 'WhatsApp पर चैट करें',
  floatingCall: 'हमें कॉल करें',
  blockUnavailable: 'यह सेक्शन दिखाया नहीं जा सका।',
  notFoundTitle: 'पेज नहीं मिला',
  notFoundText: 'आप जो पेज ढूँढ रहे हैं वह मौजूद नहीं है या हटा दिया गया है।',
  backHome: 'होम पेज पर वापस जाएँ',
};

export const STRINGS: Record<Locale, Record<StringKey, string>> = { en, hi };

export function t(locale: Locale, key: StringKey, vars?: Record<string, string | number>): string {
  let out = STRINGS[locale][key];
  for (const [k, v] of Object.entries(vars ?? {})) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}

export const DAY_KEYS = {
  mon: 'dayMon',
  tue: 'dayTue',
  wed: 'dayWed',
  thu: 'dayThu',
  fri: 'dayFri',
  sat: 'daySat',
  sun: 'daySun',
} as const satisfies Record<string, StringKey>;
