/**
 * Chatter's themes, apart from how a platform paints them: the built-in list,
 * the four colours a custom theme is made of, everything else derived from
 * them, and how custom themes are stored, imported and validated.
 *
 * Shared by the web (which writes the derived variables into a stylesheet)
 * and the phone (which hands them to its styling at runtime).
 */
import { contrastRatio, hexToRgb, isDarkColor, isHexColor, mixColors, mixToContrast, normalizeToHex } from "./color";

export type ThemeMode = "light" | "dark";

export interface ThemeColors {
  background: string;
  card: string;
  accent: string;
  primary: string;
}

/**
 * Overrides for colours a theme otherwise derives from the four above.
 *
 * Every field is optional and absent means "derive it", so a theme built
 * before these existed keeps deriving and a later change to a derivation still
 * reaches it. They are here because the derivations are guesses that are
 * usually right and occasionally not: a sidebar that wants to be darker than
 * its mix, borders that want to be barely there or clearly drawn, and a
 * mention highlight that was not themeable at all before.
 */
export interface ThemeAdvanced {
  /** Replaces the background/card mix behind the room and channel lists. */
  sidebar?: string;
  /** The tint behind a message that mentions you. */
  mention?: string;
  /** Alpha on the accent for borders and inputs, 0 to 1. */
  borderStrength?: number;
}

export const DEFAULT_BORDER_STRENGTH = 0.3;

export interface ThemeDefinition {
  id: string;
  name: string;
  /** Which base palette the theme sits on — `:root` or `.dark`. It decides the
   *  colours a theme does not name for itself: destructive, success, warning
   *  and info all come from the base block. */
  mode: ThemeMode;
  /** A custom theme carries the four colours it was built from. A built-in
   *  carries `null`: its colours are the oklch block in `index.css`, which is
   *  the single place they are written down. `resolveThemeColors` reads them
   *  back from there rather than keeping a second, drifting copy here. */
  colors: ThemeColors | null;
  /** Custom themes only, and optional even there. */
  advanced?: ThemeAdvanced;
}

export const DEFAULT_THEME_ID = "dark";

/** Not a theme — a standing instruction to follow the OS. It resolves to the
 *  `light` or `dark` built-in and re-resolves when the OS flips, so it is kept
 *  out of `THEMES` and handled where the active theme is chosen. */
export const SYSTEM_THEME_ID = "system";

export const THEMES: ThemeDefinition[] = [
  { id: "light", name: "Light", mode: "light", colors: null },
  { id: "dark", name: "Default Dark", mode: "dark", colors: null },
  { id: "midnight", name: "Midnight", mode: "dark", colors: null },
  { id: "forest", name: "Forest", mode: "dark", colors: null },
  { id: "rose", name: "Rose", mode: "dark", colors: null },
  { id: "discord", name: "Discord", mode: "dark", colors: null },
  { id: "cotton-candy", name: "Cotton Candy", mode: "dark", colors: null },
  { id: "neon", name: "Neon", mode: "dark", colors: null },
];

export const STORAGE_KEY = "chatter_theme";
export const CUSTOM_THEMES_KEY = "chatter_custom_themes";

/** WCAG AA for body text. Secondary text is still text. */
export const MIN_TEXT_CONTRAST = 4.5;

/** A text/ground pair the editor checks, in the order they are shown. */
export const CONTRAST_PAIRS = [
  { label: "Text on background", text: "primary", ground: "background" },
  { label: "Text on cards", text: "primary", ground: "card" },
  { label: "Text on accent", text: "primary", ground: "accent" },
] as const satisfies readonly {
  label: string;
  text: keyof ThemeColors;
  ground: keyof ThemeColors;
}[];

export interface ContrastCheck {
  label: string;
  ratio: number;
  passes: boolean;
}

/**
 * How the four chosen colours read against each other.
 *
 * Advisory: a theme that fails is still saved. Someone deliberately building a
 * low-contrast theme for themselves is entitled to, and the warning is there
 * for the far more common case of not having noticed.
 */
export function checkContrast(colors: ThemeColors): ContrastCheck[] {
  return CONTRAST_PAIRS.map(({ label, text, ground }) => {
    const ratio = contrastRatio(colors[text], colors[ground]);
    return { label, ratio, passes: ratio >= MIN_TEXT_CONTRAST };
  });
}

export function deriveThemeVars(
  colors: ThemeColors,
  advanced: ThemeAdvanced = {},
): Record<string, string> {
  const { background, card, accent, primary } = colors;
  const [ar, ag, ab] = hexToRgb(accent);
  const secondary = mixColors(background, card, 0.5);
  // 55% of the way to the foreground is the look this wants; the floor is what
  // stops that being unreadable against a background it was not chosen for.
  const mutedFg = mixToContrast(
    background,
    primary,
    background,
    MIN_TEXT_CONTRAST,
    0.55,
  );
  const borderAlpha = advanced.borderStrength ?? DEFAULT_BORDER_STRENGTH;
  const onAccent = (alpha: number) => `rgba(${ar}, ${ag}, ${ab}, ${alpha})`;
  const sidebar = advanced.sidebar ?? mixColors(background, card, 0.3);
  // Amber at a tenth, the value this was hardcoded to in the message row
  // before a theme could say otherwise.
  const mention = advanced.mention ?? "#fbbf24";

  // Deliberately absent: destructive, success, warning and info. Those are not
  // derivable from four colours — red has to stay red — and pinning them here
  // is what used to give a pale custom theme the dark palette's status
  // colours. Left unset they fall through to the base block the theme's mode
  // selects, which has a tuned pair for each.
  return {
    "--background": background,
    "--foreground": primary,
    "--card": card,
    "--card-foreground": primary,
    "--popover": mixColors(card, background, 0.2),
    "--popover-foreground": primary,
    "--primary": primary,
    "--primary-foreground": background,
    "--secondary": secondary,
    "--secondary-foreground": primary,
    "--muted": secondary,
    "--muted-foreground": mutedFg,
    "--accent": accent,
    "--accent-foreground": primary,
    "--border": onAccent(borderAlpha),
    "--input": onAccent(Math.min(1, borderAlpha + 0.05)),
    "--mention": mention,
    "--ring": accent,
    "--chart-1": accent,
    "--chart-2": mixColors(accent, primary, 0.3),
    "--chart-3": primary,
    "--chart-4": mixColors(accent, primary, 0.6),
    "--chart-5": mixColors(accent, background, 0.3),
    "--sidebar": sidebar,
    "--sidebar-foreground": primary,
    "--sidebar-primary": accent,
    "--sidebar-primary-foreground": primary,
    "--sidebar-accent": secondary,
    "--sidebar-accent-foreground": primary,
    "--sidebar-border": onAccent(borderAlpha),
    "--sidebar-ring": accent,
  };
}

/** Ids reach a CSS attribute selector, so they are limited to characters that
 *  cannot end the quoted string or open anything. `newThemeId` only ever
 *  produces these; the check is for ids arriving from storage or a server. */
const SAFE_THEME_ID = /^[A-Za-z0-9_-]+$/;

export function isSafeThemeId(id: unknown): id is string {
  return typeof id === "string" && id.length <= 64 && SAFE_THEME_ID.test(id);
}

export function newThemeId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Themes stored before modes existed have no `mode`, and were all rendered
 *  dark whatever their colours. Reading one back infers the mode its colours
 *  actually call for. */
/** Read the optional overrides, dropping anything that is not a usable value.
 *  Returns undefined rather than an empty object so "derive everything" has
 *  one representation. */
export function normalizeAdvanced(raw: unknown): ThemeAdvanced | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Record<string, unknown>;
  const out: ThemeAdvanced = {};
  if (isHexColor(a.sidebar)) out.sidebar = a.sidebar.toLowerCase();
  if (isHexColor(a.mention)) out.mention = a.mention.toLowerCase();
  if (
    typeof a.borderStrength === "number" &&
    Number.isFinite(a.borderStrength) &&
    a.borderStrength >= 0 &&
    a.borderStrength <= 1
  ) {
    out.borderStrength = a.borderStrength;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A theme read back from storage or a server: hex colours, a safe id, a
 *  mode (inferred for themes stored before modes), or null if unusable. */
export function normalizeStoredTheme(raw: unknown): ThemeDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const colors = t.colors as Record<string, unknown> | undefined;
  if (!colors) return null;
  const keys = ["background", "card", "accent", "primary"] as const;
  if (!keys.every((k) => isHexColor(colors[k]))) return null;

  const resolved = Object.fromEntries(
    keys.map((k) => [k, (colors[k] as string).toLowerCase()]),
  ) as unknown as ThemeColors;

  return {
    id: isSafeThemeId(t.id) ? t.id : newThemeId(),
    name: typeof t.name === "string" ? t.name : "Custom",
    mode:
      t.mode === "light" || t.mode === "dark"
        ? t.mode
        : isDarkColor(resolved.background)
          ? "dark"
          : "light",
    colors: resolved,
    advanced: normalizeAdvanced(t.advanced),
  };
}

/** Write the custom theme list back, returning it so callers can use this
 *  inside a state updater. A full or blocked store costs the user the theme on
 *  the next load, which is not worth failing the edit they just made. */
export function persistCustomThemes(next: ThemeDefinition[]): ThemeDefinition[] {
  try {
    localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(next));
  } catch {
    // Applied now, forgotten on reload.
  }
  return next;
}

export function loadCustomThemes(): ThemeDefinition[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeStoredTheme)
      .filter((t): t is ThemeDefinition => t !== null);
  } catch {
    return [];
  }
}

/** Read one colour out of imported JSON, accepting anything CSS can parse and
 *  storing hex — the editor's colour inputs take nothing else. */
function parseColorField(data: Record<string, unknown>, key: string): string {
  const raw = data[key];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`Theme is missing "${key}"`);
  }
  const hex = normalizeToHex(raw, "");
  if (!hex) throw new Error(`"${key}" is not a colour: ${raw}`);
  return hex;
}

/** Parse an exported theme. Exported alongside `mode`, but older exports and
 *  hand-written JSON carry only colours, so the mode stays optional. */
export function parseImportedTheme(json: string): ThemeDefinition {
  const data = JSON.parse(json) as Record<string, unknown>;
  if (typeof data.name !== "string" || !data.name.trim()) {
    throw new Error("Theme is missing \"name\"");
  }
  const colors: ThemeColors = {
    background: parseColorField(data, "background"),
    card: parseColorField(data, "card"),
    accent: parseColorField(data, "accent"),
    primary: parseColorField(data, "primary"),
  };
  return {
    id: newThemeId(),
    name: data.name.trim(),
    mode:
      data.mode === "light" || data.mode === "dark"
        ? data.mode
        : isDarkColor(colors.background)
          ? "dark"
          : "light",
    colors,
    advanced: normalizeAdvanced(data.advanced),
  };
}

/** A custom theme as the account's appearance settings carry it
 *  (`/api/appearance`): `advanced` omitted rather than null, so what goes up
 *  compares equal to what comes back. */
export function themeToAppearance(theme: ThemeDefinition) {
  return {
    id: theme.id,
    name: theme.name,
    mode: theme.mode,
    colors: theme.colors!,
    ...(theme.advanced ? { advanced: theme.advanced } : {}),
  };
}

/** A custom theme from the account's appearance settings, or null when it is
 *  not one this client can trust (an unsafe id, a colour that is not hex). */
export function themeFromAppearance(raw: unknown): ThemeDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as { id?: unknown; name?: unknown; mode?: unknown; colors?: Record<string, unknown>; advanced?: unknown };
  const c = t.colors;
  if (!c || !isSafeThemeId(t.id)) return null;
  const keys = ["background", "card", "accent", "primary"] as const;
  if (!keys.every((k) => isHexColor(c[k]))) return null;
  if (t.mode !== "light" && t.mode !== "dark") return null;
  return {
    id: t.id,
    name: typeof t.name === "string" ? t.name : "Custom",
    mode: t.mode,
    colors: { background: c.background as string, card: c.card as string, accent: c.accent as string, primary: c.primary as string },
    advanced: normalizeAdvanced(t.advanced),
  };
}
