import { BLOCKS } from '@platform/schema';
import { CtaButton, Picture } from '../parts';
import type { BlockDefinition, PropsOf } from '../types';

export const hero: BlockDefinition<PropsOf<'hero'>> = {
  type: 'hero',
  label: 'Hero',
  description: 'The first screen: headline, supporting line, calls to action and a main image.',
  variants: [
    { id: 'split-image', label: 'Text with image beside it' },
    { id: 'centered', label: 'Centered text' },
    { id: 'full-bleed', label: 'Image behind the text' },
  ],
  providesH1: true,
  schema: BLOCKS.hero.props,
  fields: [
    { path: 'headline', label: 'Headline', kind: 'text', required: true, maxLength: 120 },
    { path: 'subheadline', label: 'Supporting line', kind: 'longtext', maxLength: 600 },
    { path: 'primaryCta', label: 'Main button', kind: 'cta' },
    { path: 'secondaryCta', label: 'Second button', kind: 'cta' },
    {
      path: 'image',
      label: 'Main image',
      kind: 'image',
      help: 'Add a description for people who cannot see it.',
    },
  ],
  defaults: () => ({
    headline: 'Your business, online and ready for customers',
    subheadline: 'Tell visitors what you do, who it is for and how to reach you.',
    primaryCta: { label: 'Call us', action: 'tel' },
  }),
  render({ props, variant, ctx, asH1, priority }) {
    const Heading = asH1 ? 'h1' : 'h2';
    const showImage = props.image && variant !== 'centered';
    return (
      <div className={`pb-hero pb-hero--${variant}`}>
        {props.image && variant === 'full-bleed' ? (
          <div className="pb-hero__bg">
            <Picture image={props.image} ctx={ctx} sizes="100vw" priority={priority} />
          </div>
        ) : null}
        <div className="pb-container pb-hero__grid">
          <div className="pb-hero__copy">
            <Heading className="pb-h1">{props.headline}</Heading>
            {props.subheadline ? <p className="pb-lead">{props.subheadline}</p> : null}
            <div className="pb-actions">
              <CtaButton cta={props.primaryCta} ctx={ctx} />
              <CtaButton cta={props.secondaryCta} ctx={ctx} variant="secondary" />
            </div>
          </div>
          {showImage && variant === 'split-image' && props.image ? (
            <div className="pb-hero__media">
              <Picture image={props.image} ctx={ctx} priority={priority} />
            </div>
          ) : null}
        </div>
      </div>
    );
  },
};
