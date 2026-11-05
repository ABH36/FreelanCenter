import { BLOCKS } from '@platform/schema';
import { Icon } from '../icons';
import { Picture, Rich } from '../parts';
import type { BlockDefinition, PropsOf } from '../types';

export const about: BlockDefinition<PropsOf<'about'>> = {
  type: 'about',
  label: 'About',
  description: 'Who you are and why customers trust you.',
  variants: [
    { id: 'text-image', label: 'Text with image' },
    { id: 'text-only', label: 'Text only' },
  ],
  schema: BLOCKS.about.props,
  fields: [
    { path: 'heading', label: 'Heading', kind: 'text', required: true, maxLength: 120 },
    {
      path: 'body',
      label: 'Story',
      kind: 'richtext',
      required: true,
      help: 'Bold, italic, links and line breaks only.',
    },
    { path: 'image', label: 'Image', kind: 'image' },
    {
      path: 'highlights',
      label: 'Key points',
      kind: 'list',
      maxItems: 6,
      itemFields: [{ path: '', label: 'Point', kind: 'text', maxLength: 120 }],
    },
  ],
  defaults: () => ({
    heading: 'About us',
    body: [
      { type: 'text', text: 'Share your story, your experience and what makes your service different.' },
    ],
  }),
  render({ props, variant, ctx, id }) {
    return (
      <div className={`pb-container pb-about pb-about--${variant}`}>
        <div className="pb-about__copy">
          <h2 id={`${id}-title`} className="pb-h2">
            {props.heading}
          </h2>
          <p className="pb-prose">
            <Rich value={props.body} basePath={ctx.basePath} />
          </p>
          {props.highlights?.length ? (
            <ul className="pb-checks">
              {props.highlights.map((h, i) => (
                <li key={i}>
                  <Icon name="check" />
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {props.image && variant === 'text-image' ? (
          <div className="pb-about__media">
            <Picture image={props.image} ctx={ctx} />
          </div>
        ) : null}
      </div>
    );
  },
};
