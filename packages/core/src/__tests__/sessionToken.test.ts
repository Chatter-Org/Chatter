import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGetAuthenticatedBytes, configureApi, isServerUrl, setAccessToken } from "../api";
import { configureHost, resetHost } from "../platform";

/**
 * The session's token goes to this server and nowhere else. A link in a
 * message can name any site, and the encrypted-file viewer and the
 * signed-upload image fetch it with the token.
 */
describe("the session token", () => {
  afterEach(() => {
    configureApi({ origin: "" });
    resetHost();
    setAccessToken(null);
    vi.unstubAllGlobals();
  });

  it("knows this server's addresses from everyone else's", () => {
    configureHost({ origin: () => "https://chat.example" });
    expect(isServerUrl("/external/abc/x.enc")).toBe(true);
    expect(isServerUrl("https://chat.example/external/abc/x.enc")).toBe(true);
    expect(isServerUrl("https://attacker.example/external/abc/x.enc")).toBe(false);
    expect(isServerUrl("https://chat.example.attacker.example/x")).toBe(false);
    expect(isServerUrl("https://chat.example@attacker.example/x")).toBe(false);
    expect(isServerUrl("http://chat.example/x")).toBe(false);
    // Read as another host by fetch, though they start with a slash.
    expect(isServerUrl("//attacker.example/x")).toBe(false);
    expect(isServerUrl("/\\attacker.example/x")).toBe(false);
  });

  it("uses the configured server where the app is not served from it", () => {
    configureApi({ origin: "https://chat.example" });
    expect(isServerUrl("/api/x")).toBe(true);
    expect(isServerUrl("https://chat.example/api/x")).toBe(true);
    expect(isServerUrl("https://attacker.example/api/x")).toBe(false);
  });

  it("with no origin to compare against, trusts only a plain path", () => {
    expect(isServerUrl("/api/x")).toBe(true);
    expect(isServerUrl("//attacker.example/x")).toBe(false);
    expect(isServerUrl("https://attacker.example/x")).toBe(false);
  });

  it("is never sent to another site", async () => {
    configureHost({ origin: () => "https://chat.example" });
    setAccessToken("secret-token");
    const fetched: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetched.push({ url, auth: new Headers(init?.headers).get("Authorization") });
      return new Response(new Uint8Array([1, 2, 3]));
    });
    await expect(apiGetAuthenticatedBytes("https://attacker.example/external/0123/x.enc")).rejects.toThrow();
    expect(fetched).toEqual([]);

    await apiGetAuthenticatedBytes("https://chat.example/external/0123/x.enc");
    expect(fetched).toEqual([{ url: "https://chat.example/external/0123/x.enc", auth: "Bearer secret-token" }]);
  });
});
