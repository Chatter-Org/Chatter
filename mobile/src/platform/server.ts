import Constants from "expo-constants";
import { configureApi } from "@chatter/core/api";

/**
 * Which Chatter server this app talks to.
 *
 * Chatter is self-hosted, so the server is the person's choice, made on the
 * sign-in screen and remembered. A build carries a default (app.config.ts):
 * chatter.zgaf.io for a release, the local dev server for a development build.
 */
const KEY = "chatter.server";

const extra = (Constants.expoConfig?.extra ?? {}) as { defaultServer?: string; isDev?: boolean };
export const DEFAULT_SERVER = extra.defaultServer ?? "https://chatter.zgaf.io";
export const IS_DEV_BUILD = !!extra.isDev;

/** The saved server's origin, or the build's default. */
export function currentServer(): string {
  try {
    return localStorage.getItem(KEY) || DEFAULT_SERVER;
  } catch {
    return DEFAULT_SERVER;
  }
}

/**
 * Turn what someone typed into an origin: `chat.example.com` becomes
 * `https://chat.example.com`, trailing paths and slashes go.
 *
 * Throws with a message fit to show when it is not a server this build may
 * use. Plain http is refused except for a development build on this machine:
 * a session token sent in the clear is a session anyone on the network has.
 */
export function normalizeServer(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter your server's address.");
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("That doesn't look like a server address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The address should start with https://");
  }
  if (url.protocol === "http:") {
    const local = ["localhost", "127.0.0.1", "10.0.2.2"].includes(url.hostname);
    if (!(IS_DEV_BUILD && local)) throw new Error("The server must use https://");
  }
  return url.origin;
}

/** Remember a server and point the API at it. */
export function setServer(origin: string): void {
  try {
    localStorage.setItem(KEY, origin);
  } catch {
    // Storage unavailable: it holds for this run.
  }
  configureApi({ origin });
}

/** The socket endpoint for the current server. */
export function socketUrl(): string {
  return currentServer().replace(/^http/, "ws") + "/ws";
}

/** A server path (an avatar, an upload) as an absolute URL. */
export function serverAsset(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  if (/^[a-z]+:/i.test(path)) return path;
  return currentServer() + (path.startsWith("/") ? path : `/${path}`);
}
