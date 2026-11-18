/**
 * Copy of the client review page (P3 S8a, FR-PUB-05) in English and Hindi. The site's own language
 * (`business.language`) picks one. `{name}` placeholders are filled with already-escaped text by the caller.
 */
const en = {
  pinLink: 'Comment on this section',
  panelLink: 'Comments and approval',
  title: 'Review {name}',
  intro: '{sender} shared this version of {name} with you for review.',
  publishedAt: 'Version published on {date}.',
  backToSite: 'Back to the website',
  // P3 S8b (DG-37 g): a POST the page refused (it did not come from the review page itself).
  refusedTitle: 'This could not be sent',
  refusedText:
    'Your browser sent this from somewhere other than the review page, so nothing was saved. Open the review page and try again.',
  backToReview: 'Go back to the review page',
  approveHeading: 'Approve this version',
  approveText:
    'Approving tells {sender} that this version is ready to go live. You can still leave comments.',
  approveCheck: 'I approve this version of the website',
  approveButton: 'Approve',
  approvedBy: 'Approved by {who} on {date}.',
  commentHeading: 'Leave a comment',
  where: 'Where',
  wholeSite: 'The whole website',
  wholePage: '{page}: whole page',
  name: 'Your name',
  email: 'Your e-mail (optional)',
  emailHint: 'Only {sender} sees it, to reply to you.',
  comment: 'Comment',
  send: 'Send comment',
  commentsHeading: 'Comments',
  noComments: 'No comments yet.',
  resolved: 'Done',
  reply: 'Reply from {sender}',
  honeypot: 'Leave this empty',
  // Results after sending (`?done=`).
  done_comment: 'Thank you, your comment was sent.',
  done_approve: 'Thank you, your approval was recorded.',
  done_already: 'This version was already approved through this link.',
  done_stale: 'The website was updated while you were looking. Please check the new version and try again.',
  done_no_section: 'That part of the website is no longer there. Please choose another place.',
  done_invalid: 'Please check your name, e-mail and comment (up to 2000 characters) and try again.',
  done_limit: 'This version has received the maximum number of comments.',
  done_slow: 'Too many comments in a short time. Please wait a few minutes and try again.',
  done_failed: 'Something went wrong. Please try again.',
} as const;

export type ReviewStringKey = keyof typeof en;

const hi: Record<ReviewStringKey, string> = {
  pinLink: 'इस हिस्से पर टिप्पणी करें',
  panelLink: 'टिप्पणियाँ और मंज़ूरी',
  title: '{name} की समीक्षा',
  intro: '{sender} ने {name} का यह वर्ज़न आपको समीक्षा के लिए भेजा है।',
  publishedAt: 'वर्ज़न {date} को प्रकाशित हुआ।',
  backToSite: 'वेबसाइट पर वापस जाएँ',
  refusedTitle: 'यह भेजा नहीं जा सका',
  refusedText:
    'आपके ब्राउज़र ने इसे समीक्षा पेज के बाहर से भेजा, इसलिए कुछ भी सेव नहीं हुआ। समीक्षा पेज खोलें और फिर से कोशिश करें।',
  backToReview: 'समीक्षा पेज पर वापस जाएँ',
  approveHeading: 'इस वर्ज़न को मंज़ूरी दें',
  approveText:
    'मंज़ूरी देने से {sender} को पता चलेगा कि यह वर्ज़न लाइव होने के लिए तैयार है। आप फिर भी टिप्पणी कर सकते हैं।',
  approveCheck: 'मैं वेबसाइट के इस वर्ज़न को मंज़ूरी देता/देती हूँ',
  approveButton: 'मंज़ूरी दें',
  approvedBy: '{who} ने {date} को मंज़ूरी दी।',
  commentHeading: 'टिप्पणी लिखें',
  where: 'कहाँ',
  wholeSite: 'पूरी वेबसाइट',
  wholePage: '{page}: पूरा पेज',
  name: 'आपका नाम',
  email: 'आपका ई-मेल (वैकल्पिक)',
  emailHint: 'इसे सिर्फ़ {sender} देखेंगे, ताकि आपको जवाब दे सकें।',
  comment: 'टिप्पणी',
  send: 'टिप्पणी भेजें',
  commentsHeading: 'टिप्पणियाँ',
  noComments: 'अभी कोई टिप्पणी नहीं है।',
  resolved: 'हो गया',
  reply: '{sender} का जवाब',
  honeypot: 'इसे ख़ाली छोड़ें',
  done_comment: 'धन्यवाद, आपकी टिप्पणी भेज दी गई।',
  done_approve: 'धन्यवाद, आपकी मंज़ूरी दर्ज हो गई।',
  done_already: 'इस लिंक से यह वर्ज़न पहले ही मंज़ूर हो चुका है।',
  done_stale: 'आपके देखते समय वेबसाइट अपडेट हो गई। कृपया नया वर्ज़न देखकर फिर कोशिश करें।',
  done_no_section: 'वेबसाइट का वह हिस्सा अब नहीं है। कृपया कोई दूसरी जगह चुनें।',
  done_invalid: 'कृपया अपना नाम, ई-मेल और टिप्पणी (2000 अक्षरों तक) जाँचकर फिर कोशिश करें।',
  done_limit: 'इस वर्ज़न पर टिप्पणियों की सीमा पूरी हो गई है।',
  done_slow: 'कम समय में बहुत सारी टिप्पणियाँ। कृपया कुछ मिनट रुककर फिर कोशिश करें।',
  done_failed: 'कुछ गड़बड़ हो गई। कृपया फिर कोशिश करें।',
};

export type ReviewLocale = 'en' | 'hi';

export function rt(locale: ReviewLocale, key: ReviewStringKey, vars: Record<string, string> = {}): string {
  const template: string = locale === 'hi' ? hi[key] : en[key];
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

export const DONE_CODES = [
  'comment',
  'approve',
  'already',
  'stale',
  'no_section',
  'invalid',
  'limit',
  'slow',
  'failed',
] as const;
export type DoneCode = (typeof DONE_CODES)[number];
