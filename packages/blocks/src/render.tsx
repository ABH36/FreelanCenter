/**
 * Section rendering with block-level isolation (FR-TPL-06, SRS 5.2 "renderer safety net").
 *
 * A React error boundary does not catch errors while rendering on the server, so isolation here does not rely on one.
 * Each block is validated (`schema`), then its element tree is *expanded eagerly* inside a try/catch: every function
 * component (our blocks and parts are pure functions, no hooks) is called and replaced by its output, so a throw
 * anywhere inside a block is caught at that block. What remains is a tree of host elements that React cannot fail on.
 * A bad block becomes nothing in `public` mode and a visible placeholder in `preview`/`draft`; either way it is
 * reported through `ctx.onBlockError` with a safe summary (no props, no tenant text) and the rest of the page renders.
 */
import { Children, Fragment, cloneElement, createElement, isValidElement, type ReactNode } from 'react';
import type { Section } from '@platform/schema';
import { enterClass } from '@platform/ui';
import type { BlockErrorInfo, RenderContext } from './context';
import { registry as defaultRegistry, type BlockRegistry } from './registry';
import { t } from './strings';

const MAX_DEPTH = 60;

/** Replace every function component in the tree by its output. Throws if any component throws. */
export function expandNode(node: ReactNode, depth = 0): ReactNode {
  if (depth > MAX_DEPTH) throw new Error('Block tree is nested too deeply');
  if (Array.isArray(node)) return node.map((child) => expandNode(child, depth + 1));
  if (!isValidElement(node)) return node;
  const { type } = node;
  const props = node.props as { children?: ReactNode };
  if (typeof type === 'function') {
    // Pure function components only. A class component or a hook would throw here and be isolated like any bug.
    return expandNode((type as (p: unknown) => ReactNode)(props), depth + 1);
  }
  if ((type as unknown) === Fragment || typeof type === 'string') {
    if (props.children === undefined) return node;
    const children = Children.toArray(props.children).map((c) => expandNode(c, depth + 1));
    return cloneElement(node, undefined, ...children);
  }
  throw new Error('Unsupported element type in a block');
}

export type RenderedSection = { readonly id: string; readonly node: ReactNode };

function report(ctx: RenderContext, info: BlockErrorInfo): void {
  try {
    ctx.onBlockError?.(info);
  } catch {
    // Reporting must never break the page.
  }
}

function fallback(section: Section, ctx: RenderContext): ReactNode {
  if (ctx.mode === 'public') return null;
  return createElement(
    'section',
    { id: section.id, className: 'pb-section pb-fallback', role: 'note' },
    createElement('p', { className: 'pb-container' }, t(ctx.locale, 'blockUnavailable')),
  );
}

export interface RenderOptions {
  readonly registry?: BlockRegistry;
}

/** One section, isolated. Never throws. */
export function renderSection(
  section: Section,
  ctx: RenderContext,
  opts: { registry: BlockRegistry; asH1: boolean; priority: boolean },
): ReactNode {
  const base = { sectionId: section.id, type: section.type, variant: section.variant };
  const def = opts.registry.getBlock(section.type, section.variant);
  if (!def) {
    report(ctx, {
      ...base,
      stage: 'unknown-block',
      message: 'No block registered for this type and variant',
    });
    return fallback(section, ctx);
  }
  const parsed = def.schema.safeParse(section.props);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    report(ctx, { ...base, stage: 'props', message: `Invalid props at ${first?.path.join('.') ?? '?'}` });
    return fallback(section, ctx);
  }
  try {
    const inner = expandNode(
      def.render({
        id: section.id,
        variant: section.variant,
        props: parsed.data,
        ctx,
        asH1: opts.asH1,
        priority: opts.priority,
      }),
    );
    // The first section is above the fold: an enter animation would delay its paint (LCP), so it has none.
    const enter = opts.priority ? undefined : enterClass(ctx.motionPreset, section.motion?.enter);
    const classes = [
      'pb-section',
      `pb-py-${section.style?.paddingY ?? 'lg'}`,
      `pb-bg-${section.style?.bg ?? 'none'}`,
      enter,
    ]
      .filter(Boolean)
      .join(' ');
    return createElement('section', { id: section.id, className: classes }, inner);
  } catch (error) {
    report(ctx, {
      ...base,
      stage: 'render',
      message: error instanceof Error ? `Block render failed (${error.name})` : 'Block render failed',
    });
    return fallback(section, ctx);
  }
}

/** All visible sections of a page, each isolated. `h1Used` tells the page whether a block rendered the `<h1>`. */
export function renderSections(
  sections: readonly Section[],
  ctx: RenderContext,
  options: RenderOptions = {},
): { nodes: RenderedSection[]; h1Used: boolean } {
  const registry = options.registry ?? defaultRegistry;
  const nodes: RenderedSection[] = [];
  let h1Used = false;
  let first = true;
  for (const section of sections) {
    if (!section.visible) continue;
    const def = registry.getBlock(section.type, section.variant);
    const asH1 = !h1Used && def?.providesH1 === true;
    const node = renderSection(section, ctx, { registry, asH1, priority: first });
    if (node !== null) {
      if (asH1) h1Used = true;
      nodes.push({ id: section.id, node });
      first = false;
    }
  }
  return { nodes, h1Used };
}
