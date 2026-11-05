/** Colour maths for theme compilation and WCAG 2.1 contrast checks. Input is always a validated 6-digit hex. */

const HEX = /^#[0-9a-fA-F]{6}$/;

export type Rgb = readonly [number, number, number];

export function parseHex(hex: string): Rgb {
  if (!HEX.test(hex)) throw new Error('Not a 6-digit hex colour');
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

export function toHex([r, g, b]: Rgb): string {
  const part = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** WCAG 2.1 relative luminance. */
export function luminance(hex: string): number {
  const lin = parseHex(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG 2.1 contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Linear mix in sRGB space; `amount` 0..1 moves `from` toward `to`. */
export function mix(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  return toHex(
    [0, 1, 2].map((i) => (a[i] as number) + ((b[i] as number) - (a[i] as number)) * amount) as unknown as Rgb,
  );
}

/** Text colour (black or white) that has the higher contrast on `background`. */
export function onColor(background: string): '#000000' | '#ffffff' {
  return contrastRatio(background, '#ffffff') >= contrastRatio(background, '#000000') ? '#ffffff' : '#000000';
}
