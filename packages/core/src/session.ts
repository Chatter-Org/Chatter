/**
 * What a client may read from its own access token.
 *
 * The token is a JWT the server signs; a client cannot verify it and does not
 * need to — the server checks every request. Reading it only answers two local
 * questions: whose session this is (to restore it without a round trip), and
 * whether it has run out (to refresh before opening a socket that the server
 * would refuse).
 */

export interface AccessTokenClaims {
  /** The user id, e.g. `@alice:chatter.example`. */
  sub: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return atob(padded);
}

/** The token's claims, or null when it is not a readable JWT. */
export function readAccessToken(token: string | null | undefined): AccessTokenClaims | null {
  if (!token) return null;
  try {
    const claims = JSON.parse(base64UrlDecode(token.split(".")[1] ?? ""));
    if (typeof claims?.sub !== "string" || typeof claims?.exp !== "number") return null;
    return { sub: claims.sub, exp: claims.exp };
  } catch {
    return null;
  }
}

/** Whether the token has expired, or will within `marginMs`. An unreadable
 *  token counts as live: let the server be the one to refuse it. */
export function accessTokenExpired(token: string | null | undefined, marginMs = 0, now = Date.now()): boolean {
  const claims = readAccessToken(token);
  return !!claims && claims.exp * 1000 <= now + marginMs;
}
