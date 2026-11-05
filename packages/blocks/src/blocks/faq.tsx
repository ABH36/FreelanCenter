import { BLOCKS } from '@platform/schema';
import { Rich, SectionHeading } from '../parts';
import type { BlockDefinition, PropsOf } from '../types';

export const faq: BlockDefinition<PropsOf<'faq'>> = {
  type: 'faq',
  label: 'FAQ',
  description: 'Common questions with answers that expand on tap.',
  variants: [{ id: 'accordion', label: 'Expandable list' }],
  schema: BLOCKS.faq.props,
  fields: [
    { path: 'heading', label: 'Heading', kind: 'text', maxLength: 120 },
    {
      path: 'items',
      required: true,
      label: 'Questions',
      kind: 'list',
      maxItems: 20,
      itemFields: [
        { path: 'question', label: 'Question', kind: 'text', required: true, maxLength: 120 },
        { path: 'answer', label: 'Answer', kind: 'richtext', required: true },
      ],
    },
  ],
  defaults: () => ({
    heading: 'Frequently asked questions',
    items: [
      {
        question: 'A question customers often ask?',
        answer: [{ type: 'text', text: 'A short, clear answer.' }],
      },
    ],
  }),
  render({ props, id, ctx }) {
    // Native <details>: works without script, is keyboard accessible and announced correctly by screen readers.
    return (
      <div className="pb-container pb-narrow">
        <SectionHeading heading={props.heading} id={id} />
        <div className="pb-faq">
          {props.items.map((item, i) => (
            <details key={i} className="pb-faq__item">
              <summary>{item.question}</summary>
              <p>
                <Rich value={item.answer} basePath={ctx.basePath} />
              </p>
            </details>
          ))}
        </div>
      </div>
    );
  },
};
