import { BLOCKS, CONTACT_FIELDS } from '@platform/schema';
import { mapHref } from '../cta';
import { Icon } from '../icons';
import { CtaButton, Link, SectionHeading } from '../parts';
import { DAY_KEYS, t, type StringKey } from '../strings';
import type { BlockDefinition, PropsOf } from '../types';

const FIELD_LABEL: Record<(typeof CONTACT_FIELDS)[number], StringKey> = {
  name: 'fieldName',
  phone: 'fieldPhone',
  email: 'fieldEmail',
  message: 'fieldMessage',
  date: 'fieldDate',
  service: 'fieldService',
};
const FIELD_TYPE = { name: 'text', phone: 'tel', email: 'email', date: 'date', service: 'text' } as const;
const AUTOCOMPLETE = { name: 'name', phone: 'tel', email: 'email', date: 'off', service: 'off' } as const;

export const contact: BlockDefinition<PropsOf<'contact'>> = {
  type: 'contact',
  label: 'Contact',
  description: 'How to reach you: details, a message form and a map link.',
  variants: [
    { id: 'form-map', label: 'Form with map link' },
    { id: 'form-only', label: 'Form only' },
    { id: 'details', label: 'Contact details only' },
  ],
  schema: BLOCKS.contact.props,
  fields: [
    { path: 'heading', label: 'Heading', kind: 'text', maxLength: 120 },
    { path: 'intro', label: 'Introduction', kind: 'longtext', maxLength: 600 },
    {
      path: 'fields',
      label: 'Form fields',
      kind: 'multiselect',
      required: true,
      options: CONTACT_FIELDS,
      help: 'Ask only what you need: every extra field lowers the number of enquiries.',
    },
    { path: 'showMap', label: 'Show map link', kind: 'toggle' },
  ],
  defaults: () => ({
    heading: 'Get in touch',
    intro: 'Call, message or send us a note and we will get back to you.',
    fields: ['name', 'phone', 'message'],
    showMap: true,
  }),
  render({ props, variant, ctx, id }) {
    const { business, leadForm } = ctx;
    // A form that goes nowhere is worse than no form: until the lead endpoint exists (module 09, P5) the form
    // variants show the contact details and the call/WhatsApp buttons instead.
    const showForm = variant !== 'details' && leadForm !== null;
    const showDetails = variant !== 'form-only' || !showForm;
    const map = props.showMap !== false && variant !== 'form-only' ? mapHref(business) : null;
    const a = business.address;
    const address = [a?.line1, a?.city, a?.state, a?.postalCode].filter(Boolean).join(', ');
    return (
      <div className="pb-container pb-contact">
        <div>
          <SectionHeading heading={props.heading} intro={props.intro} id={id} />
          {showDetails ? (
            <>
              <ul className="pb-contact__details">
                {business.phone ? (
                  <li>
                    <Icon name="phone" />
                    <Link href={`tel:${business.phone}`} external={false}>
                      {business.phone}
                    </Link>
                  </li>
                ) : null}
                {business.email ? (
                  <li>
                    <Icon name="mail" />
                    <Link href={`mailto:${business.email}`} external={false}>
                      {business.email}
                    </Link>
                  </li>
                ) : null}
                {address ? (
                  <li>
                    <Icon name="map-pin" />
                    <span>{address}</span>
                  </li>
                ) : null}
                {business.hours?.map((h, i) => (
                  <li key={i}>
                    <Icon name="clock" />
                    <span>
                      {h.days.map((d) => t(ctx.locale, DAY_KEYS[d])).join(', ')}: {h.open}{' '}
                      {t(ctx.locale, 'to')} {h.close}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="pb-actions">
                <CtaButton cta={{ label: t(ctx.locale, 'whatsappUs'), action: 'whatsapp' }} ctx={ctx} />
                <CtaButton
                  cta={{ label: t(ctx.locale, 'callNow'), action: 'tel' }}
                  ctx={ctx}
                  variant="secondary"
                />
                {map ? (
                  <Link href={map} external className="pb-btn pb-btn--secondary">
                    {t(ctx.locale, 'openInMaps')}
                    <span className="pb-sr-only"> {t(ctx.locale, 'opensNewTab')}</span>
                  </Link>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
        {showForm && leadForm ? (
          <form className="pb-form" method="post" action={leadForm.action}>
            {props.fields
              .filter((f) => f !== 'message')
              .map((f) => (
                <p key={f}>
                  <label htmlFor={`${id}-${f}`}>{t(ctx.locale, FIELD_LABEL[f])}</label>
                  <input
                    id={`${id}-${f}`}
                    name={f}
                    type={FIELD_TYPE[f as keyof typeof FIELD_TYPE]}
                    autoComplete={AUTOCOMPLETE[f as keyof typeof AUTOCOMPLETE]}
                    required={f === 'name' || f === 'phone'}
                  />
                </p>
              ))}
            {props.fields.includes('message') ? (
              <p>
                <label htmlFor={`${id}-message`}>{t(ctx.locale, FIELD_LABEL.message)}</label>
                <textarea id={`${id}-message`} name="message" rows={4} maxLength={2000} />
              </p>
            ) : null}
            <button type="submit" className="pb-btn pb-btn--primary">
              {t(ctx.locale, 'sendMessage')}
            </button>
          </form>
        ) : null}
      </div>
    );
  },
};
