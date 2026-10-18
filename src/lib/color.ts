/** Color conversions for the custom color picker. Hue 0-360, saturation and value 0-100, RGB 0-255. */
export type Rgb = { r: number; g: number; b: number };
export type Hsv = { h: number; s: number; v: number };

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function hexToRgb(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!match) return null;
  const digits = match[1]!.length === 3 ? [...match[1]!].map(d => d + d).join("") : match[1]!;
  return { r: parseInt(digits.slice(0, 2), 16), g: parseInt(digits.slice(2, 4), 16), b: parseInt(digits.slice(4, 6), 16) };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return "#" + [r, g, b].map(n => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0")).join("");
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), delta = max - Math.min(R, G, B);
  const h = delta === 0 ? 0 : max === R ? 60 * (((G - B) / delta) % 6) : max === G ? 60 * ((B - R) / delta + 2) : 60 * ((R - G) / delta + 4);
  return { h: (h + 360) % 360, s: max === 0 ? 0 : (delta / max) * 100, v: max * 100 };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const S = clamp(s, 0, 100) / 100, V = clamp(v, 0, 100) / 100, H = ((h % 360) + 360) % 360;
  const c = V * S, x = c * (1 - Math.abs(((H / 60) % 2) - 1)), m = V - c;
  const [r, g, b] = H < 60 ? [c, x, 0] : H < 120 ? [x, c, 0] : H < 180 ? [0, c, x] : H < 240 ? [0, x, c] : H < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

export const hsvToHex = (hsv: Hsv): string => rgbToHex(hsvToRgb(hsv));
