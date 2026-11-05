/** Theme tokens (SRS 5.2, FR-TPL-04). Compiled to CSS variables by the renderer; nothing here is free-form CSS. */
import { z } from 'zod';
import { hexColor } from './primitives';

/**
 * Font allow-list: self-hosted through next/font, no runtime third-party font calls (SRS 5.2, Q19). Devanagari
 * capable entries are flagged; subsetting and weights are the S2 font policy.
 */
export const FONTS = [
  { name: 'Inter', devanagari: false },
  { name: 'Poppins', devanagari: true },
  { name: 'Montserrat', devanagari: false },
  { name: 'Lato', devanagari: false },
  { name: 'Roboto', devanagari: false },
  { name: 'Open Sans', devanagari: false },
  { name: 'Playfair Display', devanagari: false },
  { name: 'Hind', devanagari: true },
  { name: 'Mukta', devanagari: true },
  { name: 'Noto Sans Devanagari', devanagari: true },
] as const;
export type FontName = (typeof FONTS)[number]['name'];
const FONT_NAMES = FONTS.map((f) => f.name) as [FontName, ...FontName[]];
const fontName = z.enum(FONT_NAMES);

export const COLOR_TOKENS = ['primary', 'secondary', 'accent', 'background', 'surface', 'text'] as const;
export const MOTION_PRESETS = ['none', 'subtle', 'energetic'] as const;

export const themeSchema = z.strictObject({
  colors: z.strictObject({
    primary: hexColor,
    secondary: hexColor,
    accent: hexColor,
    background: hexColor,
    surface: hexColor,
    text: hexColor,
  }),
  typography: z.strictObject({
    heading: fontName,
    body: fontName,
    scale: z.enum(['compact', 'comfortable', 'spacious']),
  }),
  radius: z.enum(['none', 'sm', 'md', 'lg', 'xl', 'full']),
  spacing: z.enum(['compact', 'regular', 'relaxed']),
  buttons: z.strictObject({
    style: z.enum(['solid', 'outline', 'ghost']),
    shape: z.enum(['square', 'rounded', 'pill']),
    hover: z.enum(['none', 'lift', 'glow', 'darken']),
  }),
  motion: z.strictObject({
    preset: z.enum(MOTION_PRESETS),
    // Not a choice: honouring prefers-reduced-motion is an accessibility requirement (WCAG 2.1 AA).
    reducedMotionRespected: z.literal(true),
  }),
});
export type Theme = z.infer<typeof themeSchema>;
