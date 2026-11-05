/**
 * Site chrome: header with navigation, footer and the floating contact buttons (FR-TPL-02). They are driven by the
 * config's `navigation` and `footer`, not by sections, so a page cannot lose its navigation by deleting a section.
 */
import { resolveCta, resolveHref } from './cta';
import type { RenderContext } from './context';
import { Icon } from './icons';
import { CtaButton, Link } from './parts';
import { DAY_KEYS, t } from './strings';
import type { ChromeDefinition } from './types';

export const CHROME: readonly ChromeDefinition[] = [
  {
    name: 'header',
    label: 'Header and navigation',
    description:
      'Business name, menu links and an optional main button. Collapses to a menu on small screens.',
    variants: [
      { id: 'simple', label: 'Name left, menu right' },
      { id: 'centered', label: 'Centered' },
    ],
    configPath: 'navigation',
    fields: [
      {
        path: 'items',
        label: 'Menu links',
        kind: 'list',
        maxItems: 12,
        itemFields: [
          { path: 'label', label: 'Label', kind: 'text', required: true, maxLength: 120 },
          { path: 'target', label: 'Goes to', kind: 'text', required: true },
        ],
      },
      { path: 'cta', label: 'Main button', kind: 'cta' },
    ],
  },
  {
    name: 'footer',
    label: 'Footer',
    description: 'Contact details, opening hours, social links and the platform badge.',
    variants: [
      { id: 'simple', label: 'Single row' },
      { id: 'columns', label: 'Columns' },
    ],
    configPath: 'footer',
    fields: [{ path: 'showPlatformBadge', label: 'Show platform badge', kind: 'toggle' }],
  },
  {
    name: 'floating-action',
    label: 'Floating call and WhatsApp buttons',
    description: 'Buttons that stay on screen so a customer can reach you from anywhere on the page.',
    variants: [
      { id: 'none', label: 'Hidden' },
      { id: 'whatsapp', label: 'WhatsApp' },
      { id: 'call', label: 'Call' },
      { id: 'both', label: 'WhatsApp and call' },
    ],
    configPath: 'footer.floatingAction',
    fields: [
      {
        path: 'floatingAction',
        label: 'Floating buttons',
        kind: 'select',
        options: ['none', 'whatsapp', 'call', 'both'],
      },
    ],
  },
];

export function Header({
  ctx,
  currentPath,
  variant = 'simple',
}: {
  ctx: RenderContext;
  currentPath: string;
  variant?: 'simple' | 'centered';
}) {
  const { business, navigation, locale } = ctx;
  const items = navigation.items
    .map((item) => ({ item, link: resolveHref(item.target) }))
    .filter(
      (
        x,
      ): x is {
        item: (typeof navigation.items)[number];
        link: NonNullable<ReturnType<typeof resolveHref>>;
      } => x.link !== null,
    );
  const links = (
    <>
      {items.map(({ item, link }, i) => (
        <li key={i}>
          <Link href={link.href} external={link.external} className="pb-nav__link">
            <span aria-current={link.href === currentPath ? 'page' : undefined}>{item.label}</span>
          </Link>
        </li>
      ))}
    </>
  );
  const cta = navigation.cta && resolveCta(navigation.cta, business);
  // The logo replaces the written name only once its file exists; until then (and for assets that fail to resolve)
  // the business name is shown, so the header is never empty.
  const logoSrc = business.logo ? ctx.assetUrl(business.logo.assetId, 400) : null;
  return (
    <header className={`pb-header pb-header--${variant}`}>
      <a className="pb-skip" href="#main">
        {t(locale, 'skipToContent')}
      </a>
      <div className="pb-container pb-header__bar">
        <a className="pb-brand" href="/">
          {logoSrc && business.logo ? (
            <img
              className="pb-logo"
              src={logoSrc}
              alt={business.logo.alt}
              width={160}
              height={40}
              decoding="async"
            />
          ) : (
            business.name
          )}
        </a>
        <nav className="pb-nav" aria-label={t(locale, 'mainNavigation')}>
          <ul className="pb-nav__list pb-nav__list--desktop">{links}</ul>
          <details className="pb-nav__mobile">
            <summary>{t(locale, 'menu')}</summary>
            <ul className="pb-nav__list">{links}</ul>
          </details>
        </nav>
        {cta ? <CtaButton cta={navigation.cta} ctx={ctx} /> : null}
      </div>
    </header>
  );
}

export function Footer({ ctx, variant }: { ctx: RenderContext; variant?: 'simple' | 'columns' }) {
  const { business, navigation, footer, locale, platformBadge } = ctx;
  const v = variant ?? footer.variant;
  const a = business.address;
  const address = [a?.line1, a?.city, a?.state, a?.postalCode].filter(Boolean).join(', ');
  const social = Object.entries(business.social ?? {}).filter(
    ([, url]) => typeof url === 'string' && url !== '',
  );
  return (
    <footer className={`pb-footer pb-footer--${v}`}>
      <div className="pb-container pb-footer__grid">
        <div>
          <p className="pb-brand">{business.name}</p>
          {business.tagline ? <p className="pb-muted">{business.tagline}</p> : null}
          {address ? <p>{address}</p> : null}
          {business.phone ? (
            <p>
              <Link href={`tel:${business.phone}`} external={false}>
                {business.phone}
              </Link>
            </p>
          ) : null}
          {business.email ? (
            <p>
              <Link href={`mailto:${business.email}`} external={false}>
                {business.email}
              </Link>
            </p>
          ) : null}
        </div>
        {business.hours?.length ? (
          <div>
            <p className="pb-footer__title">{t(locale, 'hours')}</p>
            <ul>
              {business.hours.map((h, i) => (
                <li key={i}>
                  {h.days.map((d) => t(locale, DAY_KEYS[d])).join(', ')}: {h.open} {t(locale, 'to')} {h.close}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <nav aria-label={t(locale, 'footerNavigation')}>
          <ul>
            {navigation.items.map((item, i) => {
              const link = resolveHref(item.target);
              return link ? (
                <li key={i}>
                  <Link href={link.href} external={link.external}>
                    {item.label}
                  </Link>
                </li>
              ) : null;
            })}
          </ul>
          {social.length ? (
            <>
              <p className="pb-footer__title">{t(locale, 'follow')}</p>
              <ul>
                {social.map(([name, url]) => {
                  const link = resolveHref(String(url));
                  return link ? (
                    <li key={name}>
                      <Link href={link.href} external={link.external}>
                        {name.charAt(0).toUpperCase() + name.slice(1)}
                      </Link>
                    </li>
                  ) : null;
                })}
              </ul>
            </>
          ) : null}
        </nav>
      </div>
      {footer.showPlatformBadge && platformBadge ? (
        <p className="pb-container pb-footer__badge">
          <Link href={platformBadge.href} external>
            {platformBadge.label}
          </Link>
        </p>
      ) : null}
    </footer>
  );
}

/** Floating WhatsApp and call buttons. Each appears only when the business has that number. */
export function FloatingActions({ ctx }: { ctx: RenderContext }) {
  const mode = ctx.footer.floatingAction;
  if (mode === 'none') return null;
  const whatsapp =
    mode === 'whatsapp' || mode === 'both'
      ? resolveCta({ label: t(ctx.locale, 'floatingWhatsapp'), action: 'whatsapp' }, ctx.business)
      : null;
  const call =
    mode === 'call' || mode === 'both'
      ? resolveCta({ label: t(ctx.locale, 'floatingCall'), action: 'tel' }, ctx.business)
      : null;
  if (!whatsapp && !call) return null;
  return (
    <div className="pb-float">
      {whatsapp ? (
        <Link href={whatsapp.href} external className="pb-float__btn pb-float__btn--whatsapp">
          <Icon name="whatsapp" />
          <span className="pb-sr-only">{whatsapp.label}</span>
        </Link>
      ) : null}
      {call ? (
        <Link href={call.href} external={false} className="pb-float__btn pb-float__btn--call">
          <Icon name="phone" />
          <span className="pb-sr-only">{call.label}</span>
        </Link>
      ) : null}
    </div>
  );
}
