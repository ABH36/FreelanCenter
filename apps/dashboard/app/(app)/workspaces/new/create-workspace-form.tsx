'use client';
import { useActionState, useState } from 'react';
import { type ActionState, createWorkspaceAction } from '@/app/actions/workspaces';
import { Alert, Button, Field } from '@/components/ui';

/** Mirrors `slugify` in @platform/workspaces; the server validates again (format, reserved words, uniqueness). */
function suggest(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

export function CreateWorkspaceForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(createWorkspaceAction, {});
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  return (
    <form action={action} className="max-w-md space-y-4">
      <Alert>{state.error}</Alert>
      <Field
        id="name"
        label="Workspace name"
        required
        maxLength={100}
        autoComplete="organization"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          if (!slugEdited) setSlug(suggest(e.target.value));
        }}
        hint={state.fieldErrors?.name ?? 'Your agency or business name. You can change it later.'}
      />
      <Field
        id="slug"
        label="Address"
        required
        minLength={3}
        maxLength={48}
        pattern="[a-z0-9][a-z0-9\-]{1,46}[a-z0-9]"
        value={slug}
        onChange={(e) => {
          setSlugEdited(true);
          setSlug(e.target.value.toLowerCase());
        }}
        hint={
          state.fieldErrors?.slug ??
          `Your dashboard lives at /w/${slug || 'your-address'}. It cannot be changed later.`
        }
      />
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create workspace'}
      </Button>
    </form>
  );
}
