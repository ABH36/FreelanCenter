import type { Metadata } from 'next';
import { assignableRoles } from '@platform/auth/rbac';
import {
  changeRoleAction,
  createInvitationAction,
  invitationLinkAction,
  leaveWorkspaceAction,
  removeMemberAction,
  resendInvitationAction,
  revokeInvitationAction,
} from '@/app/actions/workspaces';
import { ActionForm, SmallButton } from '@/components/action-form';
import { Field, Panel } from '@/components/ui';
import { currentWorkspace, requireUserId, workspaces } from '@/lib/workspaces';

export const metadata: Metadata = { title: 'Members' };

const selectClass = 'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs';

/**
 * FR-WS-02 members and roles, FR-AUTH-06 invitations. Controls are shown from the capabilities the server
 * computed; every submission is authorized again by the service and by RLS.
 */
export default async function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
  const ws = await currentWorkspace((await params).slug);
  const userId = await requireUserId();
  const service = await workspaces();
  const manager = ws.can['members.manage'];
  const [members, invitations] = await Promise.all([
    service.listMembers(userId, ws.id),
    manager ? service.listInvitations(userId, ws.id) : Promise.resolve([]),
  ]);
  const assignable = assignableRoles(ws.role);
  const writable = ws.scope.writable;

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
      <Panel title={`People (${members.length})`}>
        <ul className="divide-y divide-slate-100">
          {members.map((m) => {
            const self = m.userId === userId;
            const canManage = writable && manager && !self && (m.role !== 'owner' || ws.role === 'owner');
            return (
              <li
                key={m.membershipId}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {m.name} {self ? <span className="text-xs font-normal text-slate-500">(you)</span> : null}
                  </div>
                  <div className="truncate text-xs text-slate-500">{m.email}</div>
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  {canManage ? (
                    <>
                      <ActionForm
                        action={changeRoleAction}
                        hidden={{ workspaceId: ws.id, membershipId: m.membershipId }}
                      >
                        <select
                          name="role"
                          defaultValue={m.role}
                          aria-label={`Role of ${m.name}`}
                          className={selectClass}
                        >
                          {assignable.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                        <SmallButton type="submit">Save</SmallButton>
                      </ActionForm>
                      <ActionForm
                        action={removeMemberAction}
                        hidden={{ workspaceId: ws.id, membershipId: m.membershipId }}
                        confirm={`Remove ${m.name} from ${ws.name}?`}
                      >
                        <SmallButton type="submit" variant="danger">
                          Remove
                        </SmallButton>
                      </ActionForm>
                    </>
                  ) : (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 capitalize">
                      {m.role}
                    </span>
                  )}
                  {self && writable ? (
                    <ActionForm
                      action={leaveWorkspaceAction}
                      hidden={{ workspaceId: ws.id }}
                      confirm={`Leave ${ws.name}? You will lose access at once.`}
                    >
                      <SmallButton type="submit" variant="danger">
                        Leave
                      </SmallButton>
                    </ActionForm>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>

      {manager ? (
        <Panel
          title="Invitations"
          description="Invitations expire after 7 days and work once. The invited person signs in with the invited address to accept."
        >
          {writable ? (
            <ActionForm
              action={createInvitationAction}
              hidden={{ workspaceId: ws.id }}
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <div className="flex-1">
                <Field
                  id="email"
                  label="E-mail address"
                  type="email"
                  required
                  maxLength={320}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="invite-role" className="block text-sm font-medium">
                  Role
                </label>
                <select
                  id="invite-role"
                  name="role"
                  defaultValue="editor"
                  className="block rounded-[var(--radius-base)] border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  {assignable
                    .filter((r) => r !== 'owner')
                    .map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                </select>
              </div>
              <SmallButton type="submit" variant="primary">
                Send invitation
              </SmallButton>
            </ActionForm>
          ) : null}
          <ul className="mt-5 divide-y divide-slate-100">
            {invitations.length === 0 ? (
              <li className="py-3 text-sm text-slate-500">No open invitations.</li>
            ) : null}
            {invitations.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm">{inv.email}</div>
                  <div className="text-xs text-slate-500">
                    <span className="capitalize">{inv.role}</span> ·{' '}
                    {inv.expired ? (
                      <span className="text-amber-700">expired</span>
                    ) : (
                      <>expires {inv.expiresAt.toUTCString()}</>
                    )}
                  </div>
                </div>
                {writable ? (
                  <div className="flex flex-wrap items-start gap-2 sm:max-w-sm">
                    {inv.expired ? null : (
                      <ActionForm
                        action={invitationLinkAction}
                        hidden={{ workspaceId: ws.id, invitationId: inv.id }}
                        className="flex flex-col gap-1"
                      >
                        <SmallButton type="submit">Copy link</SmallButton>
                      </ActionForm>
                    )}
                    <ActionForm
                      action={resendInvitationAction}
                      hidden={{ workspaceId: ws.id, invitationId: inv.id }}
                    >
                      <SmallButton type="submit">Resend</SmallButton>
                    </ActionForm>
                    <ActionForm
                      action={revokeInvitationAction}
                      hidden={{ workspaceId: ws.id, invitationId: inv.id }}
                      confirm="Revoke this invitation? The link stops working."
                    >
                      <SmallButton type="submit" variant="danger">
                        Revoke
                      </SmallButton>
                    </ActionForm>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </>
  );
}
