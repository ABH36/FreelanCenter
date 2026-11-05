import { BLOCKS } from '@platform/schema';
import { SectionHeading } from '../parts';
import type { BlockDefinition, PropsOf } from '../types';

export const stats: BlockDefinition<PropsOf<'stats'>> = {
  type: 'stats',
  label: 'Numbers',
  description: 'A few headline figures such as years in business or customers served.',
  variants: [
    { id: 'row', label: 'Single row' },
    { id: 'cards', label: 'Cards' },
  ],
  schema: BLOCKS.stats.props,
  fields: [
    { path: 'heading', label: 'Heading', kind: 'text', maxLength: 120 },
    {
      path: 'items',
      required: true,
      label: 'Figures',
      kind: 'list',
      maxItems: 6,
      itemFields: [
        {
          path: 'value',
          label: 'Value',
          kind: 'text',
          required: true,
          maxLength: 120,
          help: 'For example: 10+, 5,000, 4.8.',
        },
        { path: 'label', label: 'Label', kind: 'text', required: true, maxLength: 120 },
      ],
    },
  ],
  defaults: () => ({
    items: [
      { value: '10+', label: 'Years of experience' },
      { value: '1,000+', label: 'Happy customers' },
      { value: '4.8', label: 'Average rating' },
    ],
  }),
  render({ props, variant, id }) {
    return (
      <div className="pb-container">
        <SectionHeading heading={props.heading} id={id} />
        <dl className={`pb-stats pb-stats--${variant}`}>
          {props.items.map((s, i) => (
            <div key={i} className="pb-stat">
              <dt>{s.label}</dt>
              <dd>{s.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  },
};
