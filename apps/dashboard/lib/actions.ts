/**
 * Shared plumbing for server actions (S5, S6): form fields as strings and typed service failures as form state.
 * Not a server-action module itself (no use-server directive), so it may export plain helpers.
 */
import 'server-only';
import { WorkspaceError } from '@platform/workspaces';
import { withRequestContext } from './workspaces';

export interface ActionState {
  ok?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Only for invitationLinkAction: the link to copy. */
  link?: string;
}

export const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/** Typed failures become form state; anything else is a 500 (logged by Next). */
export async function runAction(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  try {
    return (await withRequestContext(fn)) ?? {};
  } catch (error) {
    if (error instanceof WorkspaceError) return { error: error.message, fieldErrors: error.fieldErrors };
    throw error;
  }
}
