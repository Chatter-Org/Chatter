import { useEffect, useEffectEvent, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { apiGetAppearance, apiSetAppearance, type AppearancePayload } from "@chatter/core/api";
import { DEFAULT_APPEARANCE_DISPLAY, themeFromAppearance, themeToAppearance, type ThemeDefinition } from "@chatter/core/theme";
import { useChatter } from "@/state/ChatterProvider";
import { useTheme } from "./ThemeProvider";

/** One write per burst of changes (the web's PUSH_DEBOUNCE_MS). */
const PUSH_DEBOUNCE_MS = 600;

/**
 * Keeps the theme in step with the account, as the web's ThemeSync does: a
 * theme built or picked on one device is there on the next.
 *
 * The same rules: nothing is pushed until the first fetch has answered (a
 * device that pushed first would overwrite the account with its defaults),
 * and an unchanged set is never sent. The web's display settings (text size,
 * radius, density, motion) have no meaning here, so whatever the account
 * holds for them is sent back as it was (the web's defaults when it holds
 * none) — the document is replaced whole.
 */
export function AppearanceSync() {
  const { accessToken, userId } = useChatter();
  const { preference, customThemes, adoptRemote } = useTheme();
  // State, not a ref: the push check has to run again once the fetch has
  // answered, or a phone holding a theme the account has never seen would
  // wait for the next change to send it.
  const [ready, setReady] = useState(false);
  const [readyUser, setReadyUser] = useState(userId);
  const synced = useRef<string | null>(null);
  const display = useRef<AppearancePayload["display"]>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);

  const local = JSON.stringify({ theme_id: preference, custom_themes: customThemes.map(themeToAppearance) });

  // Another account (or a sign-out) starts over: not ready from this render
  // on, and nothing known about what the server holds.
  if (userId !== readyUser) {
    setReadyUser(userId);
    setReady(false);
  }
  useEffect(() => {
    synced.current = null;
    display.current = null;
  }, [userId]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    apiGetAppearance()
      .then((remote) => {
        if (cancelled) return;
        display.current = remote.display;
        if (remote.theme_id !== null || remote.custom_themes !== null) {
          const themes = remote.custom_themes?.map(themeFromAppearance).filter((t): t is ThemeDefinition => t !== null) ?? null;
          adoptRemote({ themeId: remote.theme_id, customThemes: themes });
          // What was just adopted is what the server holds.
          synced.current = JSON.stringify({ theme_id: remote.theme_id, custom_themes: remote.custom_themes ?? [] });
        }
        setReady(true);
      })
      .catch(() => {
        // Unreachable: keep the local theme, and push nothing into the dark.
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, adoptRemote]);

  const push = (body: string) => {
    const { theme_id, custom_themes } = JSON.parse(body);
    // The server takes the document whole, display included.
    apiSetAppearance({ theme_id, custom_themes, display: display.current ?? DEFAULT_APPEARANCE_DISPLAY })
      .then(() => {
        synced.current = body;
      })
      .catch(() => {
        // The next change retries.
      });
  };

  useEffect(() => {
    if (!accessToken || !ready || local === synced.current) return;
    pending.current = local;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => pending.current && push(pending.current), PUSH_DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [accessToken, ready, local]);

  // Leaving the app straight after a change would otherwise lose it to the
  // debounce.
  const onAppStateChange = useEffectEvent((next: AppStateStatus) => {
    if (next === "active" || !ready) return;
    const body = pending.current;
    if (!body || body === synced.current) return;
    if (timer.current) clearTimeout(timer.current);
    push(body);
  });
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => onAppStateChange(next));
    return () => sub.remove();
  }, []);

  return null;
}
