/**
 * Shared presentational pieces. Pure functions of their props; text is always passed as children (React escapes it),
 * never as markup (SEC-04).
 */
import type { ReactNode } from 'react';
import type { AssetRef, Cta, RichText } from '@platform/schema';
import { IMAGE_WIDTHS, type RenderContext } from './context';
import { t } from './strings';
import { resolveCta, resolveHref } from './cta';

const REL = 'noopener noreferrer';

export function Link({
  href,
  external,
  className,
  children,
}: {
  href: string;
  external: boolean;
  className?: string;
  children: ReactNode;
}) {
  return external ? (
    <a href={href} className={className} target="_blank" rel={REL}>
      {children}
    </a>
  ) : (
    <a href={href} className={className}>
      {children}
    </a>
  );
}

/** Button-styled link, or nothing when the action cannot work for this business. */
export function CtaButton({
  cta,
  ctx,
  variant = 'primary',
}: {
  cta: Cta | undefined;
  ctx: RenderContext;
  variant?: 'primary' | 'secondary';
}) {
  if (!cta) return null;
  const link = resolveCta(cta, ctx.business, ctx.basePath);
  if (!link) return null;
  return (
    <Link href={link.href} external={link.external} className={`pb-btn pb-btn--${variant}`}>
      {link.label}
      {link.external ? <span className="pb-sr-only"> {t(ctx.locale, 'opensNewTab')}</span> : null}
    </Link>
  );
}

/** Restricted inline rich text rendered as elements, never as markup. */
export function Rich({ value, basePath = '' }: { value: RichText; basePath?: string }) {
  return (
    <>
      {value.map((node, i) => {
        if (node.type === 'br') return <br key={i} />;
        if (node.type === 'link') {
          const link = resolveHref(node.href, basePath);
          return link ? (
            <Link key={i} href={link.href} external={link.external}>
              {node.text}
            </Link>
          ) : (
            <span key={i}>{node.text}</span>
          );
        }
        let el: ReactNode = node.text;
        if (node.bold) el = <strong>{el}</strong>;
        if (node.italic) el = <em>{el}</em>;
        return <span key={i}>{el}</span>;
      })}
    </>
  );
}

/**
 * Image through pre-generated widths (ADR-009). While the asset is not available the placeholder keeps the layout
 * and the meaning (role="img" with the alt text), so a template renders completely before the asset pipeline exists.
 */
export function Picture({
  image,
  ctx,
  sizes = '(min-width: 1024px) 50vw, 100vw',
  priority = false,
  className = '',
}: {
  image: AssetRef;
  ctx: RenderContext;
  sizes?: string;
  priority?: boolean;
  className?: string;
}) {
  const widths = IMAGE_WIDTHS.map((w) => [w, ctx.assetUrl(image.assetId, w)] as const).filter(
    (p): p is readonly [(typeof IMAGE_WIDTHS)[number], string] => p[1] !== null,
  );
  const largest = widths[widths.length - 1];
  if (!largest) {
    return (
      <div className={`pb-image pb-image--placeholder ${className}`} role="img" aria-label={image.alt} />
    );
  }
  const smallest = widths[0] ?? largest;
  return (
    <img
      className={`pb-image ${className}`}
      src={smallest[1]}
      srcSet={widths.map(([w, url]) => `${url} ${w}w`).join(', ')}
      sizes={sizes}
      alt={image.alt}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      fetchPriority={priority ? 'high' : 'auto'}
    />
  );
}

export function SectionHeading({
  heading,
  intro,
  id,
}: {
  heading: string | undefined;
  intro?: string | undefined;
  id: string;
}) {
  if (!heading && !intro) return null;
  return (
    <header className="pb-section-head">
      {heading ? (
        <h2 id={`${id}-title`} className="pb-h2">
          {heading}
        </h2>
      ) : null}
      {intro ? <p className="pb-lead">{intro}</p> : null}
    </header>
  );
}
