import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import * as SystemUI from "expo-system-ui";
import { Uniwind } from "uniwind";
import { BUILT_IN_THEMES, THEME_COLORS, type BuiltInTheme, type ThemeColors } from "./themes.generated";

/**
 * Which of Chatter's themes is on screen.
 *
 * The choice is stored under the web's own key (`chatter_theme`), so the same
 * ids mean the same themes on both. "system" follows the phone between Light
 * and Default Dark — the one setting a phone has that a browser tab doesn't
 * make obvious.
 */
const STORAGE_KEY = "chatter_theme";
export const SYSTEM_THEME = "system";

interface ThemeValue {
  /** What was chosen: a theme id, or "system". */
  preference: string;
  /** The theme actually drawn. */
  themeId: string;
  mode: "light" | "dark";
  colors: ThemeColors;
  themes: BuiltInTheme[];
  setPreference(id: string): void;
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
    if (stored === SYSTEM_THEME || (stored && THEME_COLORS[stored])) return stored;
  } catch {
    // Storage unavailable: the default stands.
  }
  // The web's default (client/src/lib/theme/themes.ts DEFAULT_THEME_ID):
  // Chatter is dark unless someone picks otherwise. "Match phone" is a choice
  // in Appearance, not the starting point.
  return "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const [preference, setPreferenceState] = useState(readPreference);

  const themeId = preference === SYSTEM_THEME ? (scheme === "light" ? "light" : "dark") : preference;
  const meta = BUILT_IN_THEMES.find((t) => t.id === themeId);
  const mode = meta?.mode ?? "dark";
  const colors = THEME_COLORS[themeId] ?? THEME_COLORS.dark;

  useEffect(() => {
    Uniwind.setTheme(themeId as Parameters<typeof Uniwind.setTheme>[0]);
    // The window behind the app: what shows during a transition or rotation.
    void SystemUI.setBackgroundColorAsync(colors.background).catch(() => {});
  }, [themeId, colors.background]);

  const value = useMemo<ThemeValue>(
    () => ({
      preference,
      themeId,
      mode,
      colors,
      themes: BUILT_IN_THEMES,
      setPreference(id) {
        setPreferenceState(id);
        try {
          localStorage.setItem(STORAGE_KEY, id);
        } catch {
          // Holds for this run.
        }
      },
    }),
    [preference, themeId, mode, colors],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
