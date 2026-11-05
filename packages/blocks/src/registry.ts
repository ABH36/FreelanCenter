/**
 * Block registry (FR-TPL-02, ADR-004): the one place that knows which blocks exist. The renderer asks it for a block
 * by `type` and `variant`; it never switches on block names, so a new block is registered here and nowhere in the
 * renderer core. A registry can be built from any list (`createRegistry`), which is how tests add a block without
 * touching the renderer.
 */
import { about } from './blocks/about';
import { contact } from './blocks/contact';
import { ctaBanner } from './blocks/cta-banner';
import { faq } from './blocks/faq';
import { gallery } from './blocks/gallery';
import { hero } from './blocks/hero';
import { map } from './blocks/map';
import { pricing } from './blocks/pricing';
import { services } from './blocks/services';
import { stats } from './blocks/stats';
import { team } from './blocks/team';
import { testimonials } from './blocks/testimonials';
import { CHROME } from './chrome';
import type { BlockDefinition, ChromeDefinition } from './types';

export interface BlockRegistry {
  list(): readonly BlockDefinition[];
  chrome(): readonly ChromeDefinition[];
  /** The definition for a type, or `undefined`. Own entries only (`constructor` and friends are not blocks). */
  get(type: string): BlockDefinition | undefined;
  /** The definition when both the type and the variant exist. */
  getBlock(type: string, variant: string): BlockDefinition | undefined;
}

export function createRegistry(
  definitions: readonly BlockDefinition[],
  chrome: readonly ChromeDefinition[] = CHROME,
): BlockRegistry {
  const byType = new Map<string, BlockDefinition>();
  for (const d of definitions) {
    if (byType.has(d.type)) throw new Error(`Duplicate block type: ${d.type}`);
    if (d.variants.length === 0) throw new Error(`Block ${d.type} has no variants`);
    byType.set(d.type, d);
  }
  return {
    list: () => [...byType.values()],
    chrome: () => chrome,
    get: (type) => byType.get(type),
    getBlock: (type, variant) => {
      const d = byType.get(type);
      return d && d.variants.some((v) => v.id === variant) ? d : undefined;
    },
  };
}

const BUILT_IN = [
  hero,
  about,
  services,
  pricing,
  gallery,
  testimonials,
  faq,
  team,
  stats,
  contact,
  map,
  ctaBanner,
];

export const registry: BlockRegistry = createRegistry(BUILT_IN as readonly BlockDefinition[]);

/** `getBlock(type, variant)` on the built-in registry (module 04 internal API). */
export const getBlock = registry.getBlock;
export const listBlocks = registry.list;
