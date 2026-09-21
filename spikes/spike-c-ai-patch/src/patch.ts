/**
 * SPIKE C - the prompt-to-patch contract (disposable; real version lands in Phase 2 packages/schema + Phase 4 packages/ai).
 * The LLM only ever proposes a PatchSet. Deterministic code validates and applies it to a COPY of the draft.
 * Nothing the model returns is persisted unless it survives every check below.
 */
import { z } from 'zod';

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #RRGGBB colour');

// Plain text only: no markup can reach the renderer (SEC-04). Bounded lengths (config size limits, SRS 5.2).
const Text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !/[<>]/.test(v), 'markup characters < and > are not allowed in text fields');

// URLs: https, tel, mailto, wa.me only (SRS 5.2). Anything else, including javascript: and data:, is rejected.
const SafeUrl = z
  .string()
  .max(500)
  .refine(
    (v) => /^(https:\/\/|tel:\+?[0-9]{6,15}$|mailto:[^\s<>]+@[^\s<>]+$)/.test(v),
    'url scheme not allowed',
  );

const Id = z.string().regex(/^[a-z0-9-]{1,40}$/);

const HeroSection = z.strictObject({
  id: Id,
  type: z.literal('hero'),
  variant: z.enum(['split-image', 'centered', 'video-bg']),
  visible: z.boolean(),
  props: z.strictObject({
    headline: Text(120),
    subheadline: Text(240),
    ctaLabel: Text(40),
    ctaUrl: SafeUrl.optional(),
  }),
});
const ServicesSection = z.strictObject({
  id: Id,
  type: z.literal('services'),
  variant: z.enum(['cards-3', 'list', 'icons-grid']),
  visible: z.boolean(),
  props: z.strictObject({
    items: z
      .array(z.strictObject({ title: Text(60), description: Text(200), price: Text(30).optional() }))
      .max(12),
  }),
});
const PricingSection = z.strictObject({
  id: Id,
  type: z.literal('pricing'),
  variant: z.enum(['columns', 'table']),
  visible: z.boolean(),
  props: z.strictObject({
    plans: z
      .array(z.strictObject({ name: Text(40), price: Text(30), features: z.array(Text(80)).max(10) }))
      .max(6),
  }),
});
const ContactSection = z.strictObject({
  id: Id,
  type: z.literal('contact'),
  variant: z.enum(['form-map', 'form-only']),
  visible: z.boolean(),
  props: z.strictObject({
    heading: Text(80),
    fields: z
      .array(z.enum(['name', 'phone', 'email', 'message']))
      .min(1)
      .max(4),
  }),
});
export const SectionSchema = z.discriminatedUnion('type', [
  HeroSection,
  ServicesSection,
  PricingSection,
  ContactSection,
]);
export type Section = z.infer<typeof SectionSchema>;

export const ThemeTokens = ['primary', 'secondary', 'accent', 'background', 'text'] as const;

export const SiteConfigSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  business: z.strictObject({
    name: Text(80),
    category: Text(40),
    city: Text(60),
    tagline: Text(160),
    phone: Text(20),
  }),
  theme: z.strictObject({
    colors: z.strictObject({ primary: Hex, secondary: Hex, accent: Hex, background: Hex, text: Hex }),
    motion: z.enum(['none', 'subtle', 'energetic']),
  }),
  pages: z
    .array(
      z.strictObject({
        id: Id,
        path: z.string().regex(/^\/[a-z0-9-/]*$/),
        title: Text(80),
        seo: z.strictObject({ title: Text(70), description: Text(170) }),
        sections: z.array(SectionSchema).min(1).max(30),
      }),
    )
    .min(1)
    .max(10),
});
export type SiteConfig = z.infer<typeof SiteConfigSchema>;

// ---- the closed set of operations the model is allowed to propose -------------------------------------------------
export const PatchOperation = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('setThemeColor'), token: z.enum(ThemeTokens), value: Hex }),
  z.strictObject({ op: z.literal('setThemeMotion'), value: z.enum(['none', 'subtle', 'energetic']) }),
  z.strictObject({
    op: z.literal('setBusinessField'),
    field: z.enum(['name', 'tagline', 'city', 'phone']),
    value: Text(160),
  }),
  z.strictObject({
    op: z.literal('updateSectionProps'),
    sectionId: Id,
    props: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({ op: z.literal('setSectionVariant'), sectionId: Id, variant: z.string().max(40) }),
  z.strictObject({
    op: z.literal('addSection'),
    pageId: Id,
    afterSectionId: Id.nullable(),
    section: SectionSchema,
  }),
  z.strictObject({ op: z.literal('removeSection'), sectionId: Id }),
  z.strictObject({ op: z.literal('reorderSections'), pageId: Id, order: z.array(Id).min(1).max(30) }),
  z.strictObject({ op: z.literal('toggleSection'), sectionId: Id, visible: z.boolean() }),
  z.strictObject({
    op: z.literal('setPageSeo'),
    pageId: Id,
    title: Text(70).optional(),
    description: Text(170).optional(),
  }),
  // Graceful "I cannot do that safely": a valid, harmless answer instead of a hallucinated edit.
  z.strictObject({ op: z.literal('noChange'), reason: Text(200) }),
]);
export type PatchOperationT = z.infer<typeof PatchOperation>;

export const PatchSet = z.strictObject({
  summary: Text(300),
  operations: z.array(PatchOperation).min(1).max(25),
});
export type PatchSetT = z.infer<typeof PatchSet>;

// ---- deterministic application ----------------------------------------------------------------------------------
export type ApplyResult =
  { ok: true; config: SiteConfig; changed: boolean } | { ok: false; errors: string[] };

export function applyPatch(current: SiteConfig, patch: PatchSetT): ApplyResult {
  const draft: SiteConfig = structuredClone(current);
  const errors: string[] = [];
  let changed = false;

  const findSection = (id: string) => {
    for (const page of draft.pages) {
      const idx = page.sections.findIndex((s) => s.id === id);
      if (idx >= 0) return { page, idx };
    }
    return undefined;
  };
  const findPage = (id: string) => draft.pages.find((p) => p.id === id);

  for (const [i, op] of patch.operations.entries()) {
    const at = `operations[${i}] (${op.op})`;
    switch (op.op) {
      case 'setThemeColor':
        draft.theme.colors[op.token] = op.value;
        changed = true;
        break;
      case 'setThemeMotion':
        draft.theme.motion = op.value;
        changed = true;
        break;
      case 'setBusinessField':
        draft.business[op.field] = op.value;
        changed = true;
        break;
      case 'updateSectionProps': {
        const hit = findSection(op.sectionId);
        if (!hit) return errorsOnly([...errors, `${at}: unknown sectionId "${op.sectionId}"`]);
        const target = hit.page.sections[hit.idx]!;
        (hit.page.sections[hit.idx] as Section) = {
          ...target,
          props: { ...target.props, ...op.props },
        } as Section;
        changed = true;
        break;
      }
      case 'setSectionVariant': {
        const hit = findSection(op.sectionId);
        if (!hit) return errorsOnly([...errors, `${at}: unknown sectionId "${op.sectionId}"`]);
        (hit.page.sections[hit.idx] as { variant: string }).variant = op.variant;
        changed = true;
        break;
      }
      case 'addSection': {
        const page = findPage(op.pageId);
        if (!page) return errorsOnly([...errors, `${at}: unknown pageId "${op.pageId}"`]);
        if (findSection(op.section.id))
          return errorsOnly([...errors, `${at}: section id "${op.section.id}" already exists`]);
        const after =
          op.afterSectionId === null ? -1 : page.sections.findIndex((s) => s.id === op.afterSectionId);
        if (op.afterSectionId !== null && after < 0)
          return errorsOnly([...errors, `${at}: unknown afterSectionId "${op.afterSectionId}"`]);
        page.sections.splice(after + 1, 0, op.section);
        changed = true;
        break;
      }
      case 'removeSection': {
        const hit = findSection(op.sectionId);
        if (!hit) return errorsOnly([...errors, `${at}: unknown sectionId "${op.sectionId}"`]);
        hit.page.sections.splice(hit.idx, 1);
        changed = true;
        break;
      }
      case 'reorderSections': {
        const page = findPage(op.pageId);
        if (!page) return errorsOnly([...errors, `${at}: unknown pageId "${op.pageId}"`]);
        const have = page.sections.map((s) => s.id).sort();
        if (JSON.stringify([...op.order].sort()) !== JSON.stringify(have))
          return errorsOnly([
            ...errors,
            `${at}: order must contain exactly the existing section ids [${have.join(', ')}]`,
          ]);
        page.sections = op.order.map((id) => page.sections.find((s) => s.id === id)!);
        changed = true;
        break;
      }
      case 'toggleSection': {
        const hit = findSection(op.sectionId);
        if (!hit) return errorsOnly([...errors, `${at}: unknown sectionId "${op.sectionId}"`]);
        hit.page.sections[hit.idx]!.visible = op.visible;
        changed = true;
        break;
      }
      case 'setPageSeo': {
        const page = findPage(op.pageId);
        if (!page) return errorsOnly([...errors, `${at}: unknown pageId "${op.pageId}"`]);
        if (op.title !== undefined) page.seo.title = op.title;
        if (op.description !== undefined) page.seo.description = op.description;
        changed = true;
        break;
      }
      case 'noChange':
        break;
    }
  }

  // The whole document must still be a valid SiteConfig after the patch (catches bad props, bad variants, size limits).
  const parsed = SiteConfigSchema.safeParse(draft);
  if (!parsed.success) {
    return errorsOnly(
      parsed.error.issues.map((iss) => `result invalid at ${iss.path.join('.') || '(root)'}: ${iss.message}`),
    );
  }
  return { ok: true, config: parsed.data, changed };
}

const errorsOnly = (errors: string[]): ApplyResult => ({ ok: false, errors });
