import { BLOCKS } from '@platform/schema';
import { CtaButton } from '../parts';
import type { BlockDefinition, PropsOf } from '../types';

export const ctaBanner: BlockDefinition<PropsOf<'cta-banner'>> = {
  type: 'cta-banner',
  label: 'Call-to-action banner',
  description: 'A bold closing prompt with one button.',
  variants: [
    { id: 'solid', label: 'Solid colour' },
    { id: 'split', label: 'Text and button side by side' },
  ],
  schema: BLOCKS['cta-banner'].props,
  fields: [
    { path: 'headline', label: 'Headline', kind: 'text', required: true, maxLength: 120 },
    { path: 'subheadline', label: 'Supporting line', kind: 'longtext', maxLength: 600 },
    { path: 'cta', label: 'Button', kind: 'cta', required: true },
  ],
  defaults: () => ({
    headline: 'Ready to get started?',
    subheadline: 'Talk to us today.',
    cta: { label: 'WhatsApp us', action: 'whatsapp' },
  }),
  render({ props, variant, ctx }) {
    return (
      <div className={`pb-container pb-cta pb-cta--${variant}`}>
        <div>
          <h2 className="pb-h2">{props.headline}</h2>
          {props.subheadline ? <p className="pb-lead">{props.subheadline}</p> : null}
        </div>
        <div className="pb-actions">
          <CtaButton cta={props.cta} ctx={ctx} />
        </div>
      </div>
    );
  },
};
