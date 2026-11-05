import { BLOCKS } from '@platform/schema';
import { Icon } from '../icons';
import { SectionHeading } from '../parts';
import type { BlockDefinition, PropsOf } from '../types';

export const services: BlockDefinition<PropsOf<'services'>> = {
  type: 'services',
  label: 'Services',
  description: 'What you offer, with optional prices and icons.',
  variants: [
    { id: 'cards-3', label: 'Cards, three across' },
    { id: 'list', label: 'Simple list' },
    { id: 'icon-grid', label: 'Icon grid' },
  ],
  schema: BLOCKS.services.props,
  fields: [
    { path: 'heading', label: 'Heading', kind: 'text', maxLength: 120 },
    { path: 'intro', label: 'Introduction', kind: 'longtext', maxLength: 600 },
    {
      path: 'items',
      required: true,
      label: 'Services',
      kind: 'list',
      maxItems: 12,
      itemFields: [
        { path: 'title', label: 'Name', kind: 'text', required: true, maxLength: 120 },
        { path: 'description', label: 'Description', kind: 'longtext', maxLength: 600 },
        { path: 'price', label: 'Price', kind: 'text', maxLength: 120 },
        { path: 'icon', label: 'Icon', kind: 'select' },
      ],
    },
  ],
  defaults: () => ({
    heading: 'Our services',
    items: [
      { title: 'Service one', description: 'Describe what the customer gets.', icon: 'check' },
      { title: 'Service two', description: 'Describe what the customer gets.', icon: 'star' },
      { title: 'Service three', description: 'Describe what the customer gets.', icon: 'heart' },
    ],
  }),
  render({ props, variant, id }) {
    return (
      <div className="pb-container">
        <SectionHeading heading={props.heading} intro={props.intro} id={id} />
        <ul className={`pb-grid pb-services pb-services--${variant}`}>
          {props.items.map((item, i) => (
            <li key={i} className="pb-card">
              {item.icon && variant !== 'list' ? <Icon name={item.icon} className="pb-card__icon" /> : null}
              <h3 className="pb-h3">{item.title}</h3>
              {item.description ? <p>{item.description}</p> : null}
              {item.price ? <p className="pb-price">{item.price}</p> : null}
            </li>
          ))}
        </ul>
      </div>
    );
  },
};
