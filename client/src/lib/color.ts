/**
 * Colour maths shared by the theme picker and the theme editor.
 *
 * Themes arrive two ways: the built-ins are hand-authored oklch blocks in
 * `index.css`, and a custom theme is four hex colours somebody picked. Anything
 * that has to treat the two alike — drawing a swatch, exporting a theme — puts
 * the value through `normalizeToHex` first, so the rest of the code only ever
 * sees `#rrggbb`.
 */

export type Rgb = [number, number, number];

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value.trim());
}

export function hexToRgb(hex: string): Rgb {
  const h = hex.trim().replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((v) =>
        Math.round(Math.max(0, Math.min(255, v)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

export function mixColors(hex1: string, hex2: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

let probeCtx: CanvasRenderingContext2D | null | undefined;

/**
 * Resolve any colour the browser can parse — `oklch(...)`, `rgb(...)`, a
 * keyword — to `#rrggbb`.
 *
 * A canvas is the only reliable converter here. `getComputedStyle` hands an
 * `oklch()` custom property straight back as authored rather than resolving it
 * to sRGB, and `<input type="color">` accepts nothing but hex, so a built-in
 * theme could not seed the editor without this step.
 *
 * Returns `fallback` where there is no canvas at all (jsdom under test) or the
 * value does not parse.
 */
export function normalizeToHex(css: string, fallback = "#000000"): string {
  const value = css.trim();
  if (!value) return fallback;
  if (HEX_RE.test(value)) return value.toLowerCase();

  if (probeCtx === undefined) {
    try {
      probeCtx = document
        .createElement("canvas")
        .getContext("2d", { willReadFrequently: true });
    } catch {
      probeCtx = null;
    }
  }
  if (!probeCtx) return fallback;

  try {
    // An unparseable assignment to fillStyle is ignored rather than throwing,
    // so the sentinel below is what distinguishes "black" from "not a colour".
    probeCtx.fillStyle = "#ff00ff";
    probeCtx.fillStyle = value;
    if (probeCtx.fillStyle === "#ff00ff" && value !== "#ff00ff") return fallback;
    probeCtx.fillRect(0, 0, 1, 1);
    const [r, g, b] = probeCtx.getImageData(0, 0, 1, 1).data;
    return rgbToHex(r, g, b);
  } catch {
    return fallback;
  }
}

/** Perceived lightness, 0 (black) to 1 (white) — sRGB relative luminance. */
export function relativeLuminance(hex: string): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * WCAG 2.1 contrast ratio between two colours, 1 (identical) to 21
 * (black on white). 4.5 is the AA threshold for body text, 3 for large text
 * and for the boundary of a control.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Mix `from` toward `to` until the result clears `minRatio` against
 * `against`, starting at `startT` and never going back below it.
 *
 * This is the floor under a derived colour. A fixed mix ratio produces
 * readable secondary text against some backgrounds and unreadable text against
 * others, which is not something a person picking four colours should have to
 * work out for themselves.
 */
export function mixToContrast(
  from: string,
  to: string,
  against: string,
  minRatio: number,
  startT = 0,
  step = 0.05,
): string {
  let candidate = mixColors(from, to, startT);
  for (let t = startT; t <= 1; t += step) {
    candidate = mixColors(from, to, t);
    if (contrastRatio(candidate, against) >= minRatio) return candidate;
  }
  // Nothing on the line qualifies — the two endpoints are too close to
  // `against` for any mix of them to be readable. The far end is the best
  // available, and the editor warns about the pair separately.
  return to;
}

/**
 * Which base palette a theme belongs to, judged from its background.
 *
 * The threshold sits well below the midpoint because the base blocks it picks
 * between are `:root` and `.dark`: a mid-grey background reads far better
 * against the dark set's light foreground than the light set's near-black one.
 */
export function isDarkColor(hex: string): boolean {
  return relativeLuminance(hex) < 0.35;
}

// ---------- Readable accent colours ----------
//
// A colour somebody picked — a forum tag, a role — was picked against whatever
// theme they had on, and is drawn on everyone else's. A pale yellow chosen on
// a dark theme is unreadable on a light one, a navy chosen on a light theme
// vanishes on a dark one. `readableOn` keeps the colour's hue and moves only
// its lightness, in OKLCH (perceptually even, so the result still looks like
// "that colour"), until it clears a WCAG contrast target against the surfaces
// it sits on. Chroma is given up only as far as sRGB forces it.

type Oklch = { l: number; c: number; h: number };

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

// Björn Ottosson's OKLab matrices.
function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToRgb(hex).map((v) => toLinear(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  let h = (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c: Math.hypot(A, B), h };
}

/** Linear sRGB; components fall outside 0..1 when the colour is out of gamut. */
function oklchToLinear({ l: L, c, h }: Oklch): Rgb {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr);
  const B = c * Math.sin(hr);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -0.0001 && v <= 1.0001);

function oklchToHex(color: Oklch): string {
  let fitted = color;
  if (!inGamut(oklchToLinear(color))) {
    // Keep lightness and hue; give up only as much chroma as sRGB forces.
    let lo = 0;
    let hi = color.c;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ ...color, c: mid }))) lo = mid;
      else hi = mid;
    }
    fitted = { ...color, c: lo };
  }
  const [r, g, b] = oklchToLinear(fitted).map((v) => fromLinear(Math.min(1, Math.max(0, v))) * 255);
  return rgbToHex(r, g, b);
}

/** `#rgb` or `#rrggbb`, lower-cased and expanded; `null` for anything else. */
function expandHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return null;
}

const worstContrast = (hex: string, surfaces: string[]) =>
  Math.min(...surfaces.map((s) => contrastRatio(hex, s)));

const readableCache = new Map<string, string>();

/**
 * `color` as drawn on `surfaces`: unchanged when it already clears
 * `minContrast` on every one of them, otherwise the same hue at the nearest
 * lightness that does.
 *
 * Which way to move is decided by which end gets further from the surfaces,
 * not by a theme's light/dark label — a custom theme's mid-grey has no right
 * answer in its name. A yellow being darkened is turned a few degrees toward
 * amber on the way: a dark yellow at its own hue reads as olive, which is not
 * the colour anyone chose.
 *
 * Anything that is not a hex colour is returned as it came.
 */
export function readableOn(color: string, surfaces: string[], minContrast = 4.5): string {
  const hex = expandHex(color);
  const backs = surfaces.map(expandHex).filter((s): s is string => s !== null);
  if (!hex || backs.length === 0) return color;
  const key = `${hex}|${backs.join(",")}|${minContrast}`;
  const cached = readableCache.get(key);
  if (cached) return cached;

  let out = hex;
  if (worstContrast(hex, backs) < minContrast) {
    const base = hexToOklch(hex);
    const darken =
      worstContrast(oklchToHex({ ...base, l: 0 }), backs) >=
      worstContrast(oklchToHex({ ...base, l: 1 }), backs);
    if (darken && base.c > 0.04) {
      base.h -= 18 * Math.max(0, 1 - Math.abs(base.h - 100) / 25);
    }
    // Search between the colour's own lightness and the end it is moving
    // toward, for the point nearest the original that still passes.
    let near = base.l;
    let far = darken ? 0 : 1;
    let best: string | null = null;
    for (let i = 0; i < 20; i++) {
      const l = (near + far) / 2;
      const candidate = oklchToHex({ ...base, l });
      if (worstContrast(candidate, backs) >= minContrast) {
        best = candidate;
        far = l;
      } else {
        near = l;
      }
    }
    // No lightness of this hue gets there (a surface too close to the
    // middle): the far end is the most legible version on offer.
    out = best ?? oklchToHex({ ...base, l: darken ? 0 : 1 });
  }
  if (readableCache.size > 500) readableCache.clear();
  readableCache.set(key, out);
  return out;
}
