/**
 * Everything about a theme that is not React: the built-in list, how a theme's
 * colours are resolved, and how one is read in or written out.
 *
 * Split from the provider the way `lib/store` is — a file that exports both a
 * component and the constants around it cannot hot-reload either.
 */
import { normalizeToHex } from "@/lib/color";
import {
  deriveThemeVars,
  isSafeThemeId,
  type ThemeAdvanced,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeMode,
} from "@chatter/core/theme";
import type { DisplaySettings } from "./display";

// The theme model itself is shared with the phone (packages/core/src/theme.ts);
// what is left here is how the browser paints it.
export * from "@chatter/core/theme";

/** What `index.html` replays before React loads. See `writePaintCache`. */
const PAINT_KEY = "chatter_theme_paint";

/** Used where the document cannot be read — under test, or before first
 *  paint. These are the Default Dark values. */
const FALLBACK_COLORS: ThemeColors = {
  background: "#262626",
  card: "#363636",
  accent: "#5f5f5f",
  primary: "#e8e8e8",
};

const builtInColors = new Map<string, ThemeColors>();

/**
 * Read a built-in theme's four headline colours out of the stylesheet.
 *
 * The probe carries `data-theme` for every theme including light and dark —
 * `index.css` aliases the two base blocks to that attribute for exactly this
 * reason. Matching a rule on the probe itself is what stops it inheriting the
 * currently applied theme's variables down from `<html>`.
 */
function readThemeColorsFromCss(theme: ThemeDefinition): ThemeColors {
  if (typeof document === "undefined" || !document.body) return FALLBACK_COLORS;

  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;width:0;height:0;visibility:hidden;pointer-events:none";
  if (theme.mode === "dark") probe.className = "dark";
  probe.dataset.theme = theme.id;
  document.body.appendChild(probe);

  try {
    const computed = getComputedStyle(probe);
    const read = (name: keyof ThemeColors) =>
      normalizeToHex(
        computed.getPropertyValue(`--${name}`),
        FALLBACK_COLORS[name],
      );
    return {
      background: read("background"),
      card: read("card"),
      accent: read("accent"),
      primary: read("primary"),
    };
  } finally {
    probe.remove();
  }
}

/** The four colours a theme is previewed and exported by, wherever it came
 *  from. Built-in results are cached — the stylesheet does not change. */
export function resolveThemeColors(theme: ThemeDefinition): ThemeColors {
  if (theme.colors) return theme.colors;
  const cached = builtInColors.get(theme.id);
  if (cached) return cached;
  const colors = readThemeColorsFromCss(theme);
  builtInColors.set(theme.id, colors);
  return colors;
}

/** The rule a custom theme is applied through, as text.
 *
 *  `html[...]` rather than a bare attribute selector: the base blocks are class
 *  and attribute rules of equal weight, and relying on this sheet being the
 *  last one in the head loses the tie whenever HMR re-injects index.css. */
export function customThemeCss(theme: ThemeDefinition): string {
  if (!theme.colors || !isSafeThemeId(theme.id)) return "";
  const body = Object.entries(deriveThemeVars(theme.colors, theme.advanced))
    .map(([k, v]) => `${k}: ${v};`)
    .join("\n  ");
  return `html[data-theme="${theme.id}"] {\n  ${body}\n}`;
}

export function setCustomThemeStyle(css: string) {
  let el = document.getElementById(
    "custom-theme-style",
  ) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "custom-theme-style";
    document.head.appendChild(el);
  }
  el.textContent = css;
}

export function removeCustomThemeStyle() {
  document.getElementById("custom-theme-style")?.remove();
}

/**
 * Leave behind everything the pre-paint script in `index.html` needs to put the
 * theme on screen before React has loaded.
 *
 * It is a cache rather than a second implementation: the script replays this
 * verbatim and derives nothing, so the rules for what a theme looks like stay
 * in one place. A miss — a first visit, a theme changed in another tab — costs
 * one frame of the wrong palette, not a wrong theme.
 */
export function writePaintCache(theme: ThemeDefinition, css: string, bg: string) {
  try {
    localStorage.setItem(
      PAINT_KEY,
      JSON.stringify({ id: theme.id, mode: theme.mode, css, bg }),
    );
  } catch {
    // Storage full or blocked; the app still themes itself a frame later.
  }
}

/** `useSyncExternalStore` subscriber for the OS colour-scheme preference. */
export function subscribePrefersDark(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function getPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export interface ThemeSettings {
  /** Appearance that is not colour — text size, radius, density, motion. */
  display: DisplaySettings;
  /** Merge a change into the display settings. */
  setDisplay: (patch: Partial<DisplaySettings>) => void;
  resetDisplay: () => void;
  /** Adopt settings fetched from the server. See the provider. */
  adoptRemote: (remote: {
    themeId: string | null;
    customThemes: ThemeDefinition[] | null;
    display: DisplaySettings | null;
  }) => void;
  /** What the user picked — a theme id, or `SYSTEM_THEME_ID`. */
  themeId: string;
  /** The theme actually in force, resolved past `system` and past a stale or
   *  deleted id. */
  activeTheme: ThemeDefinition;
  /** The built-in `system` currently resolves to, whatever is selected. */
  systemTheme: ThemeDefinition;
  themes: ThemeDefinition[];
  customThemes: ThemeDefinition[];
  setTheme: (id: string) => void;
  addCustomTheme: (
    name: string,
    colors: ThemeColors,
    mode?: ThemeMode,
    advanced?: ThemeAdvanced,
  ) => ThemeDefinition;
  updateCustomTheme: (
    id: string,
    name: string,
    colors: ThemeColors,
    mode?: ThemeMode,
    advanced?: ThemeAdvanced,
  ) => void;
  deleteCustomTheme: (id: string) => void;
  /** A share code for a theme, or null if there is no such theme. */
  shareTheme: (id: string) => string | null;
  /** Accepts a share link, a share code, or exported JSON. */
  importTheme: (input: string) => ThemeDefinition;
}
