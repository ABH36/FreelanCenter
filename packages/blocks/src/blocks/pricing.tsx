import { BLOCKS } from '@platform/schema';
import { Icon } from '../icons';
import { CtaButton, SectionHeading } from '../parts';
import { t } from '../strings';
import type { BlockDefinition, PropsOf } from '../types';

export const pricing: BlockDefinition<PropsOf<'pricing'>> = {
  type: 'pricing',
  label: 'Pricing',
  description: 'Plans or packages with a price, feature list and button.',
  variants: [
    { id: 'tiers', label: 'Side-by-side plans' },
    { id: 'table', label: 'Comparison table' },
  ],
  schema: BLOCKS.pricing.props,
  fields: [
    { path: 'heading', label: 'Heading', kind: 'text', maxLength: 120 },
    { path: 'intro', label: 'Introduction', kind: 'longtext', maxLength: 600 },
    {
      path: 'itemLabel',
      label: 'First column heading (table)',
      kind: 'text',
      maxLength: 120,
      help: 'What the rows are, for example Car or Course. Default: Plan.',
    },
    {
      path: 'tiers',
      required: true,
      label: 'Plans',
      kind: 'list',
      maxItems: 6,
      itemFields: [
        { path: 'name', label: 'Plan name', kind: 'text', required: true, maxLength: 120 },
        { path: 'price', label: 'Price', kind: 'text', required: true, maxLength: 120 },
        {
          path: 'period',
          label: 'Per',
          kind: 'text',
          maxLength: 120,
          help: 'For example: month, ride, event.',
        },
        { path: 'features', label: 'Included', kind: 'list', maxItems: 12 },
        { path: 'highlighted', label: 'Recommended', kind: 'toggle' },
        { path: 'cta', label: 'Button', kind: 'cta' },
      ],
    },
  ],
  defaults: () => ({
    heading: 'Pricing',
    tiers: [
      { name: 'Basic', price: 'Rs 999', period: 'month', features: ['First benefit', 'Second benefit'] },
      {
        name: 'Standard',
        price: 'Rs 1,999',
        period: 'month',
        features: ['Everything in Basic', 'Third benefit'],
        highlighted: true,
      },
    ],
  }),
  render({ props, variant, ctx, id }) {
    if (variant === 'table') {
      return (
        <div className="pb-container">
          <SectionHeading heading={props.heading} intro={props.intro} id={id} />
          <div
            className="pb-table-wrap"
            role="region"
            aria-labelledby={props.heading ? `${id}-title` : undefined}
            aria-label={props.heading ? undefined : t(ctx.locale, 'price')}
            tabIndex={0}
          >
            <table className="pb-table">
              <thead>
                <tr>
                  <th scope="col">{props.itemLabel ?? t(ctx.locale, 'plan')}</th>
                  <th scope="col">{t(ctx.locale, 'price')}</th>
                  <th scope="col">{t(ctx.locale, 'included')}</th>
                </tr>
              </thead>
              <tbody>
                {props.tiers.map((tier, i) => (
                  <tr key={i}>
                    <th scope="row">{tier.name}</th>
                    <td>
                      {tier.price}
                      {tier.period ? <span className="pb-muted"> / {tier.period}</span> : null}
                    </td>
                    <td>{tier.features.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    return (
      <div className="pb-container">
        <SectionHeading heading={props.heading} intro={props.intro} id={id} />
        <ul className="pb-grid pb-tiers">
          {props.tiers.map((tier, i) => (
            <li key={i} className={`pb-card pb-tier${tier.highlighted ? ' pb-tier--highlight' : ''}`}>
              {tier.highlighted ? <p className="pb-badge">{t(ctx.locale, 'recommended')}</p> : null}
              <h3 className="pb-h3">{tier.name}</h3>
              <p className="pb-price pb-price--big">
                <span className="pb-price__amount">{tier.price}</span>
                {tier.period ? <span className="pb-price__period pb-muted"> / {tier.period}</span> : null}
              </p>
              <ul className="pb-checks">
                {tier.features.map((f, j) => (
                  <li key={j}>
                    <Icon name="check" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <CtaButton
                cta={tier.cta}
                ctx={ctx}
                variant={tier.highlighted ? 'primary' : 'secondary'}
                plan={tier.name}
              />
            </li>
          ))}
        </ul>
      </div>
    );
  },
};
