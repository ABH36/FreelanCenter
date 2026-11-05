import { BLOCKS } from '@platform/schema';
import { Picture, SectionHeading } from '../parts';
import type { BlockDefinition, PropsOf } from '../types';

export const team: BlockDefinition<PropsOf<'team'>> = {
  type: 'team',
  label: 'Team',
  description: 'The people behind the business.',
  variants: [{ id: 'cards', label: 'Cards with photo' }],
  schema: BLOCKS.team.props,
  fields: [
    { path: 'heading', label: 'Heading', kind: 'text', maxLength: 120 },
    {
      path: 'members',
      required: true,
      label: 'People',
      kind: 'list',
      maxItems: 12,
      itemFields: [
        { path: 'name', label: 'Name', kind: 'text', required: true, maxLength: 120 },
        { path: 'role', label: 'Role', kind: 'text', required: true, maxLength: 120 },
        { path: 'bio', label: 'Short bio', kind: 'longtext', maxLength: 600 },
        { path: 'image', label: 'Photo', kind: 'image' },
      ],
    },
  ],
  defaults: () => ({
    heading: 'Meet the team',
    members: [{ name: 'Team member', role: 'Role' }],
  }),
  render({ props, ctx, id }) {
    return (
      <div className="pb-container">
        <SectionHeading heading={props.heading} id={id} />
        <ul className="pb-grid pb-team">
          {props.members.map((m, i) => (
            <li key={i} className="pb-card">
              {m.image ? (
                <Picture
                  image={m.image}
                  ctx={ctx}
                  sizes="(min-width: 1024px) 25vw, 50vw"
                  className="pb-team__photo"
                />
              ) : null}
              <h3 className="pb-h3">{m.name}</h3>
              <p className="pb-muted">{m.role}</p>
              {m.bio ? <p>{m.bio}</p> : null}
            </li>
          ))}
        </ul>
      </div>
    );
  },
};
