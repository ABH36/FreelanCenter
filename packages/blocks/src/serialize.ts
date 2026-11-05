/**
 * Serialises an expanded element tree to HTML without `react-dom/server` (which Next.js refuses inside server
 * components and route handlers). `expandNode` has already replaced every function component by its output, so only
 * host elements, fragments, strings and numbers remain. The serialiser is deliberately small and strict: a fixed set
 * of tags and attributes, every value escaped, and it throws on anything else (an event handler, `style`,
 * a raw-HTML prop, a `<script>`), which the block-level isolation turns into "this block is skipped".
 * `serialize.test.tsx` renders every block through both this and `react-dom/server` and requires identical HTML.
 */
import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { expandNode } from './render';

export const escapeText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escapeAttr = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const VOID = new Set(['br', 'img', 'input']);

const TAGS = new Set([
  'a',
  'blockquote',
  'br',
  'button',
  'circle',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'ellipse',
  'em',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'img',
  'input',
  'label',
  'li',
  'line',
  'main',
  'nav',
  'ol',
  'p',
  'path',
  'polygon',
  'polyline',
  'rect',
  'section',
  'span',
  'strong',
  'summary',
  'svg',
  'table',
  'tbody',
  'td',
  'textarea',
  'th',
  'thead',
  'tr',
  'ul',
]);

/** React prop name -> HTML attribute name, for the attributes the blocks use. Anything not listed is rejected. */
const ATTRS: Record<string, string> = {
  className: 'class',
  id: 'id',
  href: 'href',
  target: 'target',
  rel: 'rel',
  src: 'src',
  srcSet: 'srcset',
  sizes: 'sizes',
  alt: 'alt',
  loading: 'loading',
  decoding: 'decoding',
  fetchPriority: 'fetchpriority',
  width: 'width',
  height: 'height',
  viewBox: 'viewBox',
  fill: 'fill',
  stroke: 'stroke',
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  focusable: 'focusable',
  role: 'role',
  tabIndex: 'tabindex',
  d: 'd',
  cx: 'cx',
  cy: 'cy',
  r: 'r',
  x: 'x',
  y: 'y',
  x1: 'x1',
  x2: 'x2',
  y1: 'y1',
  y2: 'y2',
  rx: 'rx',
  ry: 'ry',
  points: 'points',
  type: 'type',
  name: 'name',
  htmlFor: 'for',
  action: 'action',
  method: 'method',
  autoComplete: 'autocomplete',
  required: 'required',
  maxLength: 'maxlength',
  rows: 'rows',
  scope: 'scope',
};
const ARIA = /^aria-[a-z]+$/;

function attributes(props: Record<string, unknown>, tag: string): string {
  let out = '';
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || value === undefined || value === null || value === false) continue;
    const name = ATTRS[key] ?? (ARIA.test(key) ? key : undefined);
    if (!name) throw new Error(`Attribute not allowed: ${tag}[${key}]`);
    if (value === true) out += ` ${name}=""`;
    else if (typeof value === 'string' || typeof value === 'number')
      out += ` ${name}="${escapeAttr(String(value))}"`;
    else throw new Error(`Attribute value not allowed: ${tag}[${key}]`);
  }
  return out;
}

function write(node: ReactNode, depth: number): string {
  if (depth > 80) throw new Error('Tree is nested too deeply');
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return escapeText(node);
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((n) => write(n, depth + 1)).join('');
  if (!isValidElement(node)) throw new Error('Unsupported node');
  const { type } = node;
  const props = node.props as Record<string, unknown>;
  if ((type as unknown) === Fragment) return write(props['children'] as ReactNode, depth + 1);
  if (typeof type !== 'string' || !TAGS.has(type)) throw new Error('Element not allowed');
  const attrs = attributes(props, type);
  if (VOID.has(type)) {
    if (props['children'] !== undefined) throw new Error('Void element with children');
    return `<${type}${attrs}>`;
  }
  const children = Children.toArray(props['children'] as ReactNode)
    .map((c) => write(c, depth + 1))
    .join('');
  return `<${type}${attrs}>${children}</${type}>`;
}

/** Expand every component, then serialise. Throws if anything is outside the allow-list. */
export function serialize(node: ReactNode): string {
  return write(expandNode(node), 0);
}
