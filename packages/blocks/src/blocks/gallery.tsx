import { BLOCKS } from '@platform/schema';
import { Picture, SectionHeading } from '../parts';
import type { BlockDefinition, PropsOf } from '../types';

export const gallery: BlockDefinition<PropsOf<'gallery'>> = {
  type: 'gallery',
  label: 'Gallery',
  description: 'A set of photos.',
  variants: [
    { id: 'grid', label: 'Even grid' },
    { id: 'masonry', label: 'Staggered columns' },
  ],
  schema: BLOCKS.gallery.props,
  fields: [
    { path: 'heading', label: 'Heading', kind: 'text', maxLength: 120 },
    {
      path: 'images',
      required: true,
      label: 'Photos',
      kind: 'list',
      maxItems: 24,
      itemFields: [{ path: '', label: 'Photo', kind: 'image', required: true }],
    },
  ],
  defaults: () => ({
    heading: 'Gallery',
    images: [1, 2, 3, 4, 5, 6].map((n) => ({ assetId: `placeholder-${n}`, alt: `Describe photo ${n}` })),
  }),
  render({ props, variant, ctx, id }) {
    return (
      <div className="pb-container">
        <SectionHeading heading={props.heading} id={id} />
        <ul className={`pb-gallery pb-gallery--${variant}`}>
          {props.images.map((image, i) => (
            <li key={i}>
              <Picture
                image={image}
                ctx={ctx}
                sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
              />
            </li>
          ))}
        </ul>
      </div>
    );
  },
};
