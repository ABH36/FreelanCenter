'use client';
/**
 * P3 S5 (FR-BLD-04): the theme editor. Colours (picker and hex, ready-made palettes that pass contrast), fonts from the
 * allow-list, text scale, spacing, corner radius, button style/shape/hover and the motion preset. Approved 2026-11-15:
 * contrast problems are shown as warnings while editing and do not block saving (S7's preflight shows them again);
 * honouring reduced motion is not a choice. The server validates every save against the theme schema.
 */
import { useId } from 'react';
import { THEME_PALETTES, contrastChecks, type ThemeColors } from '@platform/ui/color';
import type { DraftView } from '@platform/workspaces';
import { humanize } from './schema-form';

type Theme = DraftView['config']['theme'];

export interface FontOption {
  name: string;
  devanagari: boolean;
}

const COLOR_KEYS = ['primary', 'secondary', 'accent', 'background', 'surface', 'text'] as const;
const COLOR_HELP: Record<(typeof COLOR_KEYS)[number], string> = {
  primary: 'Buttons, links and highlights',
  secondary: 'Footer and dark bands',
  accent: 'Stars, badges and icons',
  background: 'Page background',
  surface: 'Cards and light bands',
  text: 'Body text',
};
const HEX = /^#[0-9a-fA-F]{6}$/;

const inputClass =
  'block w-full rounded-[var(--radius-base)] border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary)]/20 disabled:bg-slate-50';

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  describe,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  disabled: boolean;
  describe?: (option: T) => string;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        className={inputClass}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {describe ? describe(o) : humanize(o)}
          </option>
        ))}
      </select>
    </div>
  );
}

function ColorField({
  name,
  value,
  onChange,
  disabled,
}: {
  name: (typeof COLOR_KEYS)[number];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const id = useId();
  const valid = HEX.test(value);
  return (
    <div className="space-y-1">
      <label htmlFor={`${id}-hex`} className="block text-sm font-medium">
        {humanize(name)} <span className="font-normal text-slate-600">· {COLOR_HELP[name]}</span>
      </label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${humanize(name)} colour picker`}
          className="h-9 w-12 cursor-pointer rounded border border-slate-300 bg-white"
          value={valid ? value : '#000000'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
        />
        <input
          id={`${id}-hex`}
          className={`${inputClass} font-mono uppercase`}
          value={value}
          maxLength={7}
          disabled={disabled}
          aria-invalid={valid ? undefined : true}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {valid ? null : <p className="text-xs text-red-700">Use a colour like #1D4ED8.</p>}
    </div>
  );
}

export function ThemeForm({
  theme,
  onChange,
  fonts,
  language,
  disabled,
}: {
  theme: Theme;
  onChange: (theme: Theme) => void;
  fonts: readonly FontOption[];
  language: string;
  disabled: boolean;
}) {
  const colorsValid = COLOR_KEYS.every((k) => HEX.test(theme.colors[k]));
  const problems = colorsValid ? contrastChecks(theme.colors as ThemeColors, theme.buttons.style) : [];
  const set = (patch: Partial<Theme>) => onChange({ ...theme, ...patch });
  const fontLabel = (name: string) => {
    const f = fonts.find((x) => x.name === name);
    return language === 'hi' && f && !f.devanagari ? `${name} (no Hindi letters)` : name;
  };

  return (
    <div className="space-y-5">
      <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
        <legend className="px-1 text-sm font-semibold">Colours</legend>
        <div>
          <p className="text-sm font-medium">Ready-made palettes</p>
          <p className="text-xs text-slate-600">Each one is easy to read with every button style.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {THEME_PALETTES.map((p) => (
              <button
                key={p.name}
                type="button"
                disabled={disabled}
                onClick={() => set({ colors: { ...p.colors } })}
                className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
              >
                <span aria-hidden className="flex">
                  {(['primary', 'accent', 'background', 'text'] as const).map((k) => (
                    <span
                      key={k}
                      className="size-3 border border-slate-300"
                      style={{ background: p.colors[k] }}
                    />
                  ))}
                </span>
                {p.name}
              </button>
            ))}
          </div>
        </div>
        {COLOR_KEYS.map((key) => (
          <ColorField
            key={key}
            name={key}
            value={theme.colors[key]}
            disabled={disabled}
            onChange={(value) => set({ colors: { ...theme.colors, [key]: value } })}
          />
        ))}
        <div role="status" aria-live="polite">
          {problems.length === 0 ? (
            colorsValid ? (
              <p className="text-xs text-emerald-800">All colour pairs are easy to read (WCAG AA).</p>
            ) : null
          ) : (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              <p className="font-medium">Hard to read for some visitors:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {problems.map((p) => (
                  <li key={p.pair}>
                    {p.pair}: {p.ratio}:1 (needs {p.required}:1)
                  </li>
                ))}
              </ul>
              <p className="mt-1">You can still save; publishing will warn again.</p>
            </div>
          )}
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
        <legend className="px-1 text-sm font-semibold">Text</legend>
        <Choice
          label="Heading font"
          value={theme.typography.heading}
          options={fonts.map((f) => f.name) as Theme['typography']['heading'][]}
          describe={fontLabel}
          disabled={disabled}
          onChange={(heading) => set({ typography: { ...theme.typography, heading } })}
        />
        <Choice
          label="Body font"
          value={theme.typography.body}
          options={fonts.map((f) => f.name) as Theme['typography']['body'][]}
          describe={fontLabel}
          disabled={disabled}
          onChange={(body) => set({ typography: { ...theme.typography, body } })}
        />
        <Choice
          label="Text size"
          value={theme.typography.scale}
          options={['compact', 'comfortable', 'spacious'] as const}
          disabled={disabled}
          onChange={(scale) => set({ typography: { ...theme.typography, scale } })}
        />
      </fieldset>

      <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
        <legend className="px-1 text-sm font-semibold">Shape and space</legend>
        <Choice
          label="Corner radius"
          value={theme.radius}
          options={['none', 'sm', 'md', 'lg', 'xl', 'full'] as const}
          describe={(o) =>
            ({
              none: 'None (square)',
              sm: 'Small',
              md: 'Medium',
              lg: 'Large',
              xl: 'Extra large',
              full: 'Fully round',
            })[o]
          }
          disabled={disabled}
          onChange={(radius) => set({ radius })}
        />
        <Choice
          label="Spacing"
          value={theme.spacing}
          options={['compact', 'regular', 'relaxed'] as const}
          disabled={disabled}
          onChange={(spacing) => set({ spacing })}
        />
      </fieldset>

      <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
        <legend className="px-1 text-sm font-semibold">Buttons</legend>
        <Choice
          label="Button style"
          value={theme.buttons.style}
          options={['solid', 'outline', 'ghost'] as const}
          disabled={disabled}
          onChange={(style) => set({ buttons: { ...theme.buttons, style } })}
        />
        <Choice
          label="Button shape"
          value={theme.buttons.shape}
          options={['square', 'rounded', 'pill'] as const}
          disabled={disabled}
          onChange={(shape) => set({ buttons: { ...theme.buttons, shape } })}
        />
        <Choice
          label="Button hover"
          value={theme.buttons.hover}
          options={['none', 'lift', 'glow', 'darken'] as const}
          disabled={disabled}
          onChange={(hover) => set({ buttons: { ...theme.buttons, hover } })}
        />
      </fieldset>

      <fieldset className="space-y-2 rounded-md border border-slate-200 p-3">
        <legend className="px-1 text-sm font-semibold">Motion</legend>
        <Choice
          label="Animation"
          value={theme.motion.preset}
          options={['none', 'subtle', 'energetic'] as const}
          disabled={disabled}
          onChange={(preset) => set({ motion: { ...theme.motion, preset } })}
        />
        <p className="text-xs text-slate-600">
          Visitors who ask their device for less motion always get none; that cannot be turned off.
        </p>
      </fieldset>
    </div>
  );
}

/** The part of a theme the `updateTheme` patch accepts (the reduced-motion flag is fixed by the schema). */
export function themePatchValue(theme: Theme) {
  return {
    colors: theme.colors,
    typography: theme.typography,
    radius: theme.radius,
    spacing: theme.spacing,
    buttons: theme.buttons,
    motion: { preset: theme.motion.preset },
  };
}
