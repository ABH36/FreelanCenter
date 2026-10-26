'use server';
/**
 * Project server actions (P1 S6). Thin wrappers like the S5 workspace actions: the user id comes from the
 * server-side session, every id in the form is only a selector, and the project service authorizes, validates
 * the lifecycle and audits (SEC-10). Each action is registered with the IDOR harness in
 * tests/isolation/src/actions.ts.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { type ActionState, field, runAction } from '@/lib/actions';
import { projectService, requireUserId } from '@/lib/workspaces';

/** Where to go after create/duplicate. The slug is a browser value: only a well-formed one is used in a path. */
const projectPath = (form: FormData, id: string) => {
  const slug = field(form, 'slug');
  return /^[a-z0-9-]{3,48}$/.test(slug) ? `/w/${slug}/projects/${id}` : '/';
};

const contactFrom = (form: FormData, prefix = '') => ({
  name: field(form, `${prefix}name`),
  phone: field(form, `${prefix}phone`),
  email: field(form, `${prefix}email`),
  whatsapp: field(form, `${prefix}whatsapp`),
});

/** FR-PRJ-01 (P1 part) + FR-DOM-01. `requestKey` is rendered into the form once, so a double submit is one project. */
export async function createProjectAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  let id = '';
  const state = await runAction(async () => {
    ({ id } = await (
      await projectService()
    ).createProject(userId, {
      workspaceId: field(form, 'workspaceId'),
      requestKey: field(form, 'requestKey'),
      name: field(form, 'name'),
      category: field(form, 'category'),
      city: field(form, 'city'),
      contact: contactFrom(form, 'contact_'),
    }));
  });
  if (state.error) return state;
  redirect(projectPath(form, id));
}

export async function updateProjectAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  return runAction(async () => {
    await (
      await projectService()
    ).updateProject(userId, {
      workspaceId: field(form, 'workspaceId'),
      projectId: field(form, 'projectId'),
      name: field(form, 'name'),
      category: field(form, 'category'),
      city: field(form, 'city'),
    });
    revalidatePath('/', 'layout');
    return { ok: 'Saved.' };
  });
}

export async function saveClientContactAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  return runAction(async () => {
    await (
      await projectService()
    ).saveClientContact(userId, {
      workspaceId: field(form, 'workspaceId'),
      projectId: field(form, 'projectId'),
      ...contactFrom(form),
    });
    revalidatePath('/', 'layout');
    return { ok: 'Contact saved.' };
  });
}

export async function removeClientContactAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  return runAction(async () => {
    await (
      await projectService()
    ).removeClientContact(userId, {
      workspaceId: field(form, 'workspaceId'),
      projectId: field(form, 'projectId'),
    });
    revalidatePath('/', 'layout');
    return { ok: 'Contact removed.' };
  });
}

/** FR-PRJ-02: `from` is the status the user saw; a status that changed meanwhile is refused as stale. */
export async function transitionProjectAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  return runAction(async () => {
    const { changed } = await (
      await projectService()
    ).transitionProject(userId, {
      workspaceId: field(form, 'workspaceId'),
      projectId: field(form, 'projectId'),
      from: field(form, 'from'),
      to: field(form, 'to'),
    });
    revalidatePath('/', 'layout');
    return { ok: changed ? 'Status updated.' : 'Already done.' };
  });
}

/** FR-PRJ-05: a new Draft; opens it. */
export async function duplicateProjectAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  let id = '';
  const state = await runAction(async () => {
    ({ id } = await (
      await projectService()
    ).duplicateProject(userId, {
      workspaceId: field(form, 'workspaceId'),
      projectId: field(form, 'projectId'),
      requestKey: field(form, 'requestKey'),
    }));
  });
  if (state.error) return state;
  redirect(projectPath(form, id));
}
