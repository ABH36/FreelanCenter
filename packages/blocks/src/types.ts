/** Block registry contracts: what a block is, and the editor metadata it publishes (FR-TPL-02). */
import type { ReactNode } from 'react';
import type { z } from 'zod';
import type { BLOCKS } from '@platform/schema';
import type { RenderContext } from './context';

export type PropsOf<T extends keyof typeof BLOCKS> = z.infer<(typeof BLOCKS)[T]['props']>;

export type FieldKind =
  'text' | 'longtext' | 'richtext' | 'image' | 'cta' | 'select' | 'multiselect' | 'toggle' | 'list';

/** One editable field. The builder (P3) generates its form from these; nothing here is rendered by the site. */
export interface FieldMeta {
  /** Dot path inside the block's `props`. */
  readonly path: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly help?: string;
  readonly required?: boolean;
  readonly maxLength?: number;
  readonly options?: readonly string[];
  readonly maxItems?: number;
  /** For `list`: the fields of one item (paths relative to the item). */
  readonly itemFields?: readonly FieldMeta[];
}

export interface VariantMeta {
  readonly id: string;
  readonly label: string;
}

export interface BlockInput<P> {
  readonly id: string;
  readonly variant: string;
  readonly props: P;
  readonly ctx: RenderContext;
  /** The block renders the page's single `<h1>`. */
  readonly asH1: boolean;
  /** First section on the page: its main image is eager and high priority (LCP). */
  readonly priority: boolean;
}

export interface BlockDefinition<P = unknown> {
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly variants: readonly VariantMeta[];
  /** Validates props before render; the renderer never renders props that fail it. */
  readonly schema: z.ZodType<P>;
  readonly fields: readonly FieldMeta[];
  /** This block renders the page's single <h1> (the renderer gives it to the first visible block that sets this). */
  readonly providesH1?: boolean;
  /** Valid starter content for a variant (used by the builder's "add section" and by templates). */
  defaults(variant: string): P;
  /** Pure render function: no hooks, no I/O. It may throw; the renderer isolates it. */
  render(input: BlockInput<P>): ReactNode;
}

/** Header, footer and the floating action are driven by `navigation` and `footer`, not by sections. */
export interface ChromeDefinition {
  readonly name: 'header' | 'footer' | 'floating-action';
  readonly label: string;
  readonly description: string;
  readonly variants: readonly VariantMeta[];
  /** Config path that drives it. */
  readonly configPath: string;
  readonly fields: readonly FieldMeta[];
}
