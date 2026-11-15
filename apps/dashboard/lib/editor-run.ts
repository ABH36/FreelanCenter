/**
 * The result shape of the editor's JSON server actions (P3 S3, S6): plain data the client can branch on, with the
 * service's safe message. The user id always comes from the server-side session.
 */
import 'server-only';
import { isWorkspaceError } from '@platform/workspaces';
import { requireUserId, withRequestContext } from './workspaces';

export type EditorResult<T = undefined> =
  { ok: true; value: T } | { ok: false; code: string; error: string; fieldErrors?: Record<string, string> };

export async function runEditor<T>(fn: (userId: string) => Promise<T>): Promise<EditorResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, value: await withRequestContext(() => fn(userId)) };
  } catch (error) {
    if (isWorkspaceError(error)) {
      return { ok: false, code: error.code, error: error.message, fieldErrors: error.fieldErrors };
    }
    throw error;
  }
}
