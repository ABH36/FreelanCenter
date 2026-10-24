/**
 * The project lifecycle (FR-PRJ-02, cross-module contracts): `Draft -> InReview -> Approved -> Live <-> Paused`,
 * review can send a project back to Draft, anything but Archived can be archived, and a restore goes back to
 * Draft. Pure, so the table is unit-tested cell by cell. The database repeats it in
 * `app.project_transition_roles` + trigger `projects_guard` (migration p1_s6_projects_lifecycle); the integration
 * suite asserts the two tables are equal for all 36 status pairs and all four roles.
 */
import type { Capability } from '@platform/auth/rbac';

export const PROJECT_STATUSES = ['draft', 'in_review', 'approved', 'live', 'paused', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface Transition {
  from: ProjectStatus;
  to: ProjectStatus;
  /** The SRS 7 capability that authorizes it; its roles are the ones the database allows. */
  capability: Capability;
  /** Button label in the dashboard. */
  label: string;
}

const T = (from: ProjectStatus, to: ProjectStatus, capability: Capability, label: string): Transition => ({
  from,
  to,
  capability,
  label,
});

export const PROJECT_TRANSITIONS: readonly Transition[] = [
  T('draft', 'in_review', 'draft.edit', 'Submit for review'),
  T('in_review', 'draft', 'draft.edit', 'Back to draft'),
  T('in_review', 'approved', 'version.approve', 'Approve'),
  T('approved', 'draft', 'draft.edit', 'Reopen as draft'),
  // P1 has no SiteVersion yet: going live needs an active platform subdomain; P3 adds a published version.
  T('approved', 'live', 'site.publish', 'Go live'),
  T('live', 'paused', 'site.publish', 'Pause'),
  T('paused', 'live', 'site.publish', 'Resume'),
  ...(['draft', 'in_review', 'approved', 'live', 'paused'] as const).map((from) =>
    T(from, 'archived', 'projects.archive', 'Archive'),
  ),
  T('archived', 'draft', 'projects.archive', 'Restore as draft'),
];

export function findTransition(from: ProjectStatus, to: ProjectStatus): Transition | undefined {
  return PROJECT_TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export function transitionsFrom(from: ProjectStatus): Transition[] {
  return PROJECT_TRANSITIONS.filter((t) => t.from === from);
}

export const isProjectStatus = (value: unknown): value is ProjectStatus =>
  typeof value === 'string' && (PROJECT_STATUSES as readonly string[]).includes(value);

export const STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  live: 'Live',
  paused: 'Paused',
  archived: 'Archived',
};
