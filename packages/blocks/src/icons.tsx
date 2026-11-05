/**
 * Icons for the schema icon allow-list, from Lucide (ISC licence, the most widely used open-source line icon set).
 * They render as inline SVG: decorative (`aria-hidden`), no external request, no script. Only a fixed set of SVG
 * elements and attributes is ever emitted, so icon data cannot smuggle markup even if a dependency is compromised.
 */
import {
  BookOpen,
  Calendar,
  Camera,
  Car,
  Check,
  Clock,
  Dumbbell,
  Gift,
  Heart,
  House,
  Mail,
  MapPin,
  MessageCircle,
  Music,
  Phone,
  Scissors,
  ShieldCheck,
  Sparkles,
  Star,
  Truck,
  Users,
  Utensils,
} from 'lucide';
import { createElement } from 'react';
import type { ICONS } from '@platform/schema';

export type IconName = (typeof ICONS)[number] | 'whatsapp' | 'mail';

type IconNode = readonly (readonly [string, Record<string, string | number>])[];

const NODES: Record<IconName, IconNode> = {
  dumbbell: Dumbbell as IconNode,
  car: Car as IconNode,
  heart: Heart as IconNode,
  star: Star as IconNode,
  phone: Phone as IconNode,
  'map-pin': MapPin as IconNode,
  clock: Clock as IconNode,
  check: Check as IconNode,
  shield: ShieldCheck as IconNode,
  camera: Camera as IconNode,
  music: Music as IconNode,
  calendar: Calendar as IconNode,
  users: Users as IconNode,
  scissors: Scissors as IconNode,
  utensils: Utensils as IconNode,
  home: House as IconNode,
  book: BookOpen as IconNode,
  truck: Truck as IconNode,
  sparkles: Sparkles as IconNode,
  gift: Gift as IconNode,
  // Not in the schema list: used by the chrome (floating button, contact details).
  whatsapp: MessageCircle as IconNode,
  mail: Mail as IconNode,
};

const TAGS = new Set(['path', 'circle', 'line', 'rect', 'polyline', 'polygon', 'ellipse']);
const ATTRS = new Set([
  'd',
  'cx',
  'cy',
  'r',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'width',
  'height',
  'rx',
  'ry',
  'points',
]);

export const ICON_NAMES = Object.keys(NODES) as IconName[];

/** The sanitised drawing instructions of one icon (exported for tests). */
export function iconShapes(name: IconName): { tag: string; attrs: Record<string, string> }[] {
  return NODES[name]
    .filter(([tag]) => TAGS.has(tag))
    .map(([tag, attrs]) => ({
      tag,
      attrs: Object.fromEntries(
        Object.entries(attrs)
          .filter(([k, v]) => ATTRS.has(k) && /^[0-9a-zA-Z .,\-+eE]*$/.test(String(v)))
          .map(([k, v]) => [k, String(v)]),
      ),
    }));
}

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`pb-icon ${className}`}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {iconShapes(name).map((s, i) => createElement(s.tag, { key: i, ...s.attrs }))}
    </svg>
  );
}
