import * as SecureStore from "expo-secure-store";
import type { RefreshTokenStore } from "@chatter/core/api";

/**
 * The refresh token, kept in the Android Keystore (iOS Keychain) and never in
 * plain storage.
 *
 * The web client never sees this token: the browser holds it in an HttpOnly
 * cookie. The server also accepts it in the body of /refresh, read before any
 * cookie, which is how a native client sends it. The core reads and writes it
 * through this store (configureApi in install.ts).
 *
 * Reads are synchronous so the core can call `get()` mid-request; the value is
 * cached after the first read, so the Keystore is consulted once per launch.
 */
const KEY = "chatter.refresh_token";

let cached: string | null | undefined;

export const refreshTokenStore: RefreshTokenStore = {
  get() {
    if (cached === undefined) {
      try {
        cached = SecureStore.getItem(KEY);
      } catch {
        // Keystore unreadable (a restored backup on a new device): no session.
        cached = null;
      }
    }
    return cached;
  },
  set(token) {
    cached = token;
    try {
      if (token) SecureStore.setItem(KEY, token);
      else void SecureStore.deleteItemAsync(KEY).catch(() => {});
    } catch {
      // Keystore unavailable: the session lasts until the process does.
    }
  },
};

/** Whether a session can be restored without asking for a password. */
export function hasStoredSession(): boolean {
  return !!refreshTokenStore.get();
}
