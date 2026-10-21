import { apiLogoutDevice } from "@chatter/core/api";

/**
 * End this device's session on the server, leaving the account signed in on
 * every other device. The server's plain logout ends all of them, which is
 * what the web's "Sign out" means but not what putting a phone down should.
 *
 * Best effort: a server that cannot be reached still loses this device, since
 * the token is forgotten locally either way (clearTokens).
 */
export async function signOutThisDevice(): Promise<void> {
  try {
    await apiLogoutDevice();
  } catch {
    // Offline: the token is dropped locally and expires on the server.
  }
}
