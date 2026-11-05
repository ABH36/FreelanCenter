import { BLOCKS } from '@platform/schema';
import { mapHref } from '../cta';
import { Icon } from '../icons';
import { Link, SectionHeading } from '../parts';
import { t } from '../strings';
import type { BlockDefinition, PropsOf } from '../types';

export const map: BlockDefinition<PropsOf<'map'>> = {
  type: 'map',
  label: 'Location',
  description: 'Address and a link to open the location in a maps app. No third-party embed is loaded.',
  variants: [{ id: 'link-card', label: 'Address card with map link' }],
  schema: BLOCKS.map.props,
  fields: [
    { path: 'heading', label: 'Heading', kind: 'text', maxLength: 120 },
    {
      path: 'note',
      label: 'Directions note',
      kind: 'longtext',
      maxLength: 600,
      help: 'For example: near the main market, second floor.',
    },
  ],
  defaults: () => ({ heading: 'Find us' }),
  render({ props, ctx, id }) {
    const href = mapHref(ctx.business);
    const a = ctx.business.address;
    const address = [a?.line1, a?.city, a?.state, a?.postalCode].filter(Boolean).join(', ');
    return (
      <div className="pb-container pb-narrow">
        <SectionHeading heading={props.heading} id={id} />
        <div className="pb-card pb-location">
          <Icon name="map-pin" className="pb-card__icon" />
          {address ? <p className="pb-h3">{address}</p> : null}
          {props.note ? <p>{props.note}</p> : null}
          {href ? (
            <Link href={href} external className="pb-btn pb-btn--primary">
              {t(ctx.locale, 'openInMaps')}
              <span className="pb-sr-only"> {t(ctx.locale, 'opensNewTab')}</span>
            </Link>
          ) : null}
        </div>
      </div>
    );
  },
};
