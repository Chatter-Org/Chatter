import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import * as SystemUI from "expo-system-ui";
import { Uniwind } from "uniwind";
import {
  SYSTEM_THEME_ID,
  deriveThemeVars,
  loadCustomThemes,
  newThemeId,
  persistCustomThemes,
  type ThemeAdvanced,
  type ThemeColors as BaseColors,
  type ThemeDefinition,
  type ThemeMode,
} from "@chatter/core/theme";
import { encodeThemeShare, parseThemeInput } from "@chatter/core/themeShare";
import { BUILT_IN_THEMES, CUSTOM_THEME_ID, THEME_COLORS, type BuiltInTheme, type ThemeColors, type ThemeToken } from "./themes.generated";

/**
 * Which of Chatter's themes is on screen.
 *
 * The choice and the custom themes are stored under the web's own keys
 * (`chatter_theme`, `chatter_custom_themes`), so the same ids mean the same
 * themes on both, and the account's appearance settings sync them between
 * devices (AppearanceSync). "system" follows the phone between Light and
 * Default Dark.
 *
 * A custom theme is four colours; the rest is derived by the web's own rules
 * (core/theme.ts) and written into the stylesheet's runtime slot, with the
 * status colours (destructive, success...) from the base its mode names.
 */
const STORAGE_KEY = "chatter_theme";
export const SYSTEM_THEME = SYSTEM_THEME_ID;

interface ThemeValue {
  /** What was chosen: a theme id, or "system". */
  preference: string;
  /** The theme actually drawn. */
  themeId: string;
  mode: ThemeMode;
  colors: ThemeColors;
  themes: BuiltInTheme[];
  customThemes: ThemeDefinition[];
  setPreference(id: string): void;
  addCustomTheme(name: string, colors: BaseColors, mode: ThemeMode, advanced?: ThemeAdvanced): ThemeDefinition;
  updateCustomTheme(id: string, name: string, colors: BaseColors, mode: ThemeMode, advanced?: ThemeAdvanced): void;
  deleteCustomTheme(id: string): void;
  /** A share code for a custom theme. */
  shareCode(id: string): string | null;
  /** A share link, a share code, or exported JSON; added and returned. Throws
   *  with a message for the reader when the input is not a theme. */
  importTheme(input: string): ThemeDefinition;
  /** The account's settings, fetched from the server (AppearanceSync). */
  adoptRemote(remote: { themeId: string | null; customThemes: ThemeDefinition[] | null }): void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}

function readPreference(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // Storage unavailable: the default stands.
  }
  // The web's default (DEFAULT_THEME_ID): Chatter is dark unless someone
  // picks otherwise. "Match phone" is a choice in Appearance.
  return "dark";
}

/** A custom theme as the full token set: derived over its mode's base. */
export function customThemeColors(theme: ThemeDefinition): ThemeColors {
  const base = THEME_COLORS[theme.mode === "light" ? "light" : "dark"];
  if (!theme.colors) return base;
  const derived = deriveThemeVars(theme.colors, theme.advanced);
  const out = { ...base };
  for (const [name, value] of Object.entries(derived)) {
    const token = name.slice(2) as ThemeToken;
    if (token in out) out[token] = value;
  }
  return out;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const [preference, setPreferenceState] = useState(readPreference);
  const [customThemes, setCustomThemes] = useState<ThemeDefinition[]>(loadCustomThemes);

  const custom = customThemes.find((t) => t.id === preference);
  // A stale id (a custom theme deleted elsewhere) falls back to Default Dark.
  const themeId =
    preference === SYSTEM_THEME ? (scheme === "light" ? "light" : "dark") : custom ? custom.id : THEME_COLORS[preference] ? preference : "dark";
  const meta = BUILT_IN_THEMES.find((t) => t.id === themeId);
  const mode: ThemeMode = custom ? custom.mode : (meta?.mode ?? "dark");
  const colors = useMemo(() => (custom ? customThemeColors(custom) : (THEME_COLORS[themeId] ?? THEME_COLORS.dark)), [custom, themeId]);

  useEffect(() => {
    if (custom) {
      const vars: Record<string, string> = {};
      for (const [token, value] of Object.entries(colors)) vars[`--color-${token}`] = value;
      Uniwind.updateCSSVariables(CUSTOM_THEME_ID as Parameters<typeof Uniwind.updateCSSVariables>[0], vars);
      Uniwind.setTheme(CUSTOM_THEME_ID as Parameters<typeof Uniwind.setTheme>[0]);
    } else {
      Uniwind.setTheme(themeId as Parameters<typeof Uniwind.setTheme>[0]);
    }
    // The window behind the app: what shows during a transition or rotation.
    void SystemUI.setBackgroundColorAsync(colors.background).catch(() => {});
  }, [custom, themeId, colors]);

  const setPreference = useCallback((id: string) => {
    setPreferenceState(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Holds for this run.
    }
  }, []);

  // Stable, so the sync's fetch runs once per session, not per theme change.
  const adoptRemote = useCallback(
    (remote: { themeId: string | null; customThemes: ThemeDefinition[] | null }) => {
      if (remote.customThemes) setCustomThemes(persistCustomThemes(remote.customThemes));
      if (remote.themeId) setPreference(remote.themeId);
    },
    [setPreference],
  );

  const value = useMemo<ThemeValue>(
    () => ({
      preference,
      themeId,
      mode,
      colors,
      themes: BUILT_IN_THEMES,
      customThemes,
      setPreference,
      addCustomTheme(name, themeColors, themeMode, advanced) {
        const theme: ThemeDefinition = { id: newThemeId(), name: name.trim() || "Custom", mode: themeMode, colors: themeColors, advanced };
        setCustomThemes((prev) => persistCustomThemes([...prev, theme]));
        return theme;
      },
      updateCustomTheme(id, name, themeColors, themeMode, advanced) {
        setCustomThemes((prev) =>
          persistCustomThemes(prev.map((t) => (t.id === id ? { ...t, name: name.trim() || t.name, mode: themeMode, colors: themeColors, advanced } : t))),
        );
      },
      deleteCustomTheme(id) {
        setCustomThemes((prev) => persistCustomThemes(prev.filter((t) => t.id !== id)));
        if (preference === id) setPreference("dark");
      },
      shareCode(id) {
        const theme = customThemes.find((t) => t.id === id);
        return theme?.colors ? encodeThemeShare({ name: theme.name, mode: theme.mode, colors: theme.colors, advanced: theme.advanced }) : null;
      },
      importTheme(input) {
        const theme = parseThemeInput(input);
        setCustomThemes((prev) => persistCustomThemes([...prev, theme]));
        return theme;
      },
      adoptRemote,
    }),
    [preference, themeId, mode, colors, customThemes, setPreference, adoptRemote],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
