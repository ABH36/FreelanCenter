/**
 * Workspace slugs (FR-WS-01) and the shared reserved-word list (FR-WS-03: from S6 the same list guards platform
 * subdomain labels, Q9). The database enforces the same rules with CHECK constraints (`workspaces_slug_format`,
 * `workspaces_slug_not_reserved`); `RESERVED_SLUGS` must equal `app.reserved_slugs()` and the integration suite
 * asserts it.
 */

/** 3-48 characters, lower-case letters, digits and single hyphens, no hyphen at either end. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;

// prettier-ignore
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // infrastructure and mail host names
  'www', 'www1', 'www2', 'app', 'apps', 'api', 'apis', 'admin', 'administrator', 'root', 'mail', 'email',
  'smtp', 'imap', 'pop3', 'webmail', 'mailbox', 'ftp', 'sftp', 'ssh', 'vpn', 'dns', 'ns1', 'ns2', 'ns3',
  'cdn', 'static', 'assets', 'media', 'img', 'images', 'files', 'uploads', 'download', 'downloads',
  'dashboard', 'console', 'portal', 'preview', 'staging', 'stage', 'dev', 'development', 'test', 'testing',
  'demo', 'sandbox', 'beta', 'alpha', 'internal', 'intranet', 'local', 'localhost', 'status', 'health',
  'metrics', 'monitor', 'system', 'null', 'undefined',
  // product routes and account flows
  'auth', 'login', 'logout', 'signin', 'signout', 'signup', 'sign-in', 'sign-out', 'sign-up', 'register',
  'account', 'accounts', 'billing', 'pay', 'payment', 'payments', 'checkout', 'invoice', 'invoices',
  'settings', 'profile', 'security', 'support', 'help', 'helpdesk', 'docs', 'documentation', 'blog', 'news',
  'about', 'contact', 'legal', 'privacy', 'terms', 'tos', 'abuse', 'report', 'postmaster', 'hostmaster',
  'webmaster', 'noreply', 'no-reply', 'info', 'sales', 'marketing', 'careers', 'jobs', 'press', 'team',
  'store', 'shop', 'marketplace', 'template', 'templates', 'site', 'sites', 'domain', 'domains',
  'workspace', 'workspaces', 'project', 'projects', 'invite', 'invites', 'invitation', 'invitations',
  'oauth', 'sso', 'saml', 'webhook', 'webhooks', 'inngest', 'cron', 'new', 'edit', 'create', 'delete',
  // our own brand (working name, D1) and frequently impersonated brands
  'platform', 'freelancenter', 'google', 'gmail', 'youtube', 'facebook', 'meta', 'instagram', 'whatsapp',
  'apple', 'icloud', 'microsoft', 'outlook', 'office', 'amazon', 'aws', 'paypal', 'paytm', 'phonepe',
  'gpay', 'razorpay', 'stripe', 'visa', 'mastercard', 'rupay', 'upi', 'sbi', 'hdfc', 'icici', 'irctc',
  'uidai', 'aadhaar', 'incometax', 'gov', 'govt', 'vercel', 'supabase', 'cloudflare', 'github',
]);

export type SlugProblem = 'format' | 'reserved';

/** null when the slug is acceptable (uniqueness is the database's job). */
export function slugProblem(slug: string): SlugProblem | null {
  if (!SLUG_PATTERN.test(slug) || slug.includes('--')) return 'format';
  if (RESERVED_SLUGS.has(slug)) return 'reserved';
  return null;
}

/** A slug proposal from a display name: ASCII-folded, lower-case, hyphenated, trimmed to 48 characters. */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return base.length >= 3 ? base : `${base || 'workspace'}-team`.replace(/^-/, '');
}
