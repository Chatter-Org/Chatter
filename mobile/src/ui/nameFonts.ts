import { useEffect, useSyncExternalStore } from "react";
import type { TextStyle } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import * as Font from "expo-font";
import { isSafeNameFontUrl } from "@chatter/core/nameFont";
import { serverAsset, sessionHeaders } from "@/platform/server";

/**
 * People's own fonts on their names — the web's `ensureFontFace` (fontFace.ts).
 *
 * A font is fetched once with the session (uploads can need sign-in, and the
 * font loader sends no headers), kept in the cache, and registered under a
 * family named after its URL, so a new font is a new family rather than a
 * stale one. Until it is ready, and for a font Android cannot read (.woff and
 * .woff2 are browser formats), the name stays in the app's own font.
 */
type FontState = "loading" | "ready" | "failed";

const states = new Map<string, FontState>();
const listeners = new Set<() => void>();

function publish() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A family name from the URL: stable, and safe as an identifier. */
function familyFor(url: string): string {
  let hash = 5381;
  for (let i = 0; i < url.length; i++) hash = ((hash << 5) + hash + url.charCodeAt(i)) >>> 0;
  return `namefont_${hash.toString(36)}`;
}

async function load(url: string) {
  if (states.has(url)) return;
  states.set(url, "loading");
  try {
    const remote = serverAsset(url);
    if (!remote) throw new Error("no server");
    const family = familyFor(url);
    const ext = /\.(ttf|otf|woff2?)$/i.exec(url)?.[1]?.toLowerCase() ?? "ttf";
    const dir = new Directory(Paths.cache, "name-fonts");
    if (!dir.exists) dir.create({ intermediates: true });
    let file = new File(dir, `${family}.${ext}`);
    if (!file.exists) {
      const headers = sessionHeaders(remote);
      file = await File.downloadFileAsync(remote, file, headers ? { headers } : undefined);
    }
    await Font.loadAsync({ [family]: file.uri });
    states.set(url, "ready");
  } catch {
    states.set(url, "failed");
  }
  publish();
}

/**
 * The style that puts someone's font on their name, once it has loaded; none
 * before then, or without one. Weight is left to the font: Android draws a
 * single-file family in the system font when asked for a weight it lacks.
 */
export function useNameFont(url: string | null | undefined): TextStyle | undefined {
  const safe = isSafeNameFontUrl(url) ? url : null;
  const state = useSyncExternalStore(subscribe, () => (safe ? states.get(safe) : undefined));
  useEffect(() => {
    if (safe) void load(safe);
  }, [safe]);
  return safe && state === "ready" ? { fontFamily: familyFor(safe), fontWeight: "normal" } : undefined;
}
