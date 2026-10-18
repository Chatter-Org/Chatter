/**
 * What the shared core (packages/core) needs from a phone, installed before it
 * loads. Imported first thing in index.ts.
 *
 *   localStorage   → expo-sqlite's synchronous Web Storage polyfill. The core
 *                    keeps small, non-secret UI state there, as on the web.
 *   server origin  → configureApi({ origin }) from the saved server choice.
 *   refresh token  → configureApi({ refreshTokenStore }), in the Keystore. The
 *                    browser keeps it in an HttpOnly cookie instead.
 *   host           → toasts, sounds, notifications, focus and events, done
 *                    natively (host.ts).
 *
 * Deliberately not polyfilled: `document`, `window`, `Notification`,
 * `AudioContext`. The core never touches them unguarded, and many React
 * Native libraries test `typeof document` to decide they are on the web.
 */
import "expo-sqlite/localStorage/install";
import { configureApi } from "@chatter/core/api";
import { configureHost } from "@chatter/core/platform";
import { nativeHost } from "./host";
import { currentServer } from "./server";
import { refreshTokenStore } from "./tokenStore";

configureApi({ origin: currentServer(), refreshTokenStore });
configureHost(nativeHost);
