/**
 * Space colours are pastels; in dark mode each becomes a deep tint of its own hue. The hue is
 * kept and the colour is redrawn dark (a fixed lightness, about half the saturation), so that
 * two Spaces still tell apart: mixing the pastel into one dark base left them all the same navy.
 */
const DARK_LIGHTNESS = 0.19;
const DARK_SATURATION = 0.55;

export function spaceTint(color: string, dark: boolean) {
  if (!dark) return color;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  if ([r, g, b].some(Number.isNaN)) return color;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (chroma !== 0) {
    if (max === r) hue = ((g - b) / chroma) % 6;
    else if (max === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
  }
  return hslToHex(hue * 60, Math.min(1, saturation) * DARK_SATURATION, DARK_LIGHTNESS);
}

function hslToHex(hue: number, saturation: number, lightness: number) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const h = (((hue % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] = h < 1 ? [chroma, x, 0] : h < 2 ? [x, chroma, 0] : h < 3 ? [0, chroma, x] : h < 4 ? [0, x, chroma] : h < 5 ? [x, 0, chroma] : [chroma, 0, x];
  const m = lightness - chroma / 2;
  return '#' + [r, g, b].map((c) => Math.round((c + m) * 255).toString(16).padStart(2, '0')).join('');
}

/** A Space colour as this page's window wears it: the pastel in light mode, its deep tint in dark mode. */
export const shownSpaceColor = (color: string) => spaceTint(color, matchMedia('(prefers-color-scheme: dark)').matches);
