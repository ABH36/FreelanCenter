import { BLOCKS } from '@platform/schema';
import { SectionHeading } from '../parts';
import { t as tr } from '../strings';
import type { BlockDefinition, PropsOf } from '../types';

export const testimonials: BlockDefinition<PropsOf<'testimonials'>> = {
  type: 'testimonials',
  label: 'Testimonials',
  description: 'What customers say about you.',
  variants: [
    { id: 'cards', label: 'Cards' },
    { id: 'single', label: 'One large quote' },
  ],
  schema: BLOCKS.testimonials.props,
  fields: [
    { path: 'heading', label: 'Heading', kind: 'text', maxLength: 120 },
    {
      path: 'items',
      required: true,
      label: 'Testimonials',
      kind: 'list',
      maxItems: 12,
      itemFields: [
        { path: 'quote', label: 'Quote', kind: 'longtext', required: true, maxLength: 600 },
        { path: 'author', label: 'Name', kind: 'text', required: true, maxLength: 120 },
        { path: 'role', label: 'Role or place', kind: 'text', maxLength: 120 },
        { path: 'rating', label: 'Rating (1-5)', kind: 'text' },
      ],
    },
  ],
  defaults: () => ({
    heading: 'What our customers say',
    items: [
      { quote: 'Replace this with a real review from a happy customer.', author: 'Customer name', rating: 5 },
    ],
  }),
  render({ props, variant, id, ctx }) {
    const items = variant === 'single' ? props.items.slice(0, 1) : props.items;
    return (
      <div className="pb-container">
        <SectionHeading heading={props.heading} id={id} />
        <ul className={`pb-grid pb-quotes pb-quotes--${variant}`}>
          {items.map((t, i) => (
            <li key={i} className="pb-card">
              <figure>
                {t.rating ? (
                  <p
                    className="pb-stars"
                    role="img"
                    aria-label={tr(ctx.locale, 'starsOutOf5', { n: t.rating })}
                  >
                    {'★'.repeat(t.rating)}
                    <span aria-hidden="true">{'☆'.repeat(5 - t.rating)}</span>
                  </p>
                ) : null}
                <blockquote>
                  <p>{t.quote}</p>
                </blockquote>
                <figcaption>
                  {ctx.mode === 'preview' ? (
                    <span className="pb-sample">{tr(ctx.locale, 'sample')}</span>
                  ) : null}
                  <strong>{t.author}</strong>
                  {t.role ? <span className="pb-muted"> · {t.role}</span> : null}
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </div>
    );
  },
};
