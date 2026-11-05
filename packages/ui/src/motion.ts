/**
 * Animation presets (FR-TPL-05). Pure CSS, no script. The theme preset sets three variables; section `motion.enter`
 * selects a class. `prefers-reduced-motion: reduce` removes every animation and transition regardless of preset
 * (WCAG 2.1 AA, and the schema pins `reducedMotionRespected` to true). Content is visible without animation support:
 * the hidden start state exists only inside the keyframes.
 */
import type { ENTER_ANIMATIONS, MOTION_PRESETS } from '@platform/schema';

export type MotionPreset = (typeof MOTION_PRESETS)[number];
export type EnterAnimation = (typeof ENTER_ANIMATIONS)[number];

export const MOTION_VALUES: Record<MotionPreset, { duration: string; distance: string; ease: string }> = {
  none: { duration: '0ms', distance: '0px', ease: 'linear' },
  subtle: { duration: '450ms', distance: '16px', ease: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  energetic: { duration: '700ms', distance: '36px', ease: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
};

/** Variables for one preset. */
export function motionVariables(preset: MotionPreset): string {
  const v = MOTION_VALUES[preset];
  return `--motion-duration:${v.duration};--motion-distance:${v.distance};--motion-ease:${v.ease};`;
}

/** Class for a section's enter animation, or `undefined` when there is nothing to apply. */
export function enterClass(preset: MotionPreset, enter: EnterAnimation | undefined): string | undefined {
  if (preset === 'none' || enter === undefined || enter === 'none') return undefined;
  return `enter-${enter}`;
}

/** Static stylesheet, identical for every site (nothing per tenant is compiled into it). */
export function motionCss(): string {
  return [
    '@keyframes enter-fade-in{from{opacity:0}to{opacity:1}}',
    '@keyframes enter-fade-up{from{opacity:0;transform:translateY(var(--motion-distance))}to{opacity:1;transform:none}}',
    '@keyframes enter-slide-left{from{opacity:0;transform:translateX(calc(var(--motion-distance) * -1.5))}to{opacity:1;transform:none}}',
    '@keyframes enter-slide-right{from{opacity:0;transform:translateX(calc(var(--motion-distance) * 1.5))}to{opacity:1;transform:none}}',
    '@keyframes enter-zoom{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:none}}',
    '.enter-fade-in,.enter-fade-up,.enter-slide-left,.enter-slide-right,.enter-zoom{animation-duration:var(--motion-duration);animation-timing-function:var(--motion-ease);animation-fill-mode:both}',
    '.enter-fade-in{animation-name:enter-fade-in}',
    '.enter-fade-up{animation-name:enter-fade-up}',
    '.enter-slide-left{animation-name:enter-slide-left}',
    '.enter-slide-right{animation-name:enter-slide-right}',
    '.enter-zoom{animation-name:enter-zoom}',
    // Progressive enhancement: start the animation when the section scrolls into view instead of on page load.
    '@supports (animation-timeline:view()){.enter-fade-in,.enter-fade-up,.enter-slide-left,.enter-slide-right,.enter-zoom{animation-timeline:view();animation-range:entry 0% entry 35%}}',
    '@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}',
  ].join('\n');
}
