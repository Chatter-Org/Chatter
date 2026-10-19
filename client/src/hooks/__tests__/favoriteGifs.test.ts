/**
 * Favourite GIFs and the categories they are sorted into, held by the account.
 *
 * Two things are worth pinning. The invariant: a category only ever holds
 * favourites — filing favourites, unfavouriting empties every category,
 * deleting a category keeps its GIFs (`applyGifFavoritesOp`, mirrored from the
 * server). And the ordering: answers and broadcasts arrive over two channels,
 * so an old one must never overwrite a newer one, and a broadcast must not
 * yank back a change of ours that is still on its way.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { GifFavoritesOp, GifFavoritesPayload } from "@/lib/api";

const api = vi.hoisted(() => ({
  apiGetGifFavorites: vi.fn(),
  apiGifFavoritesOp: vi.fn(),
}));
vi.mock("@chatter/core/api", () => api);

let storage: Map<string, string>;

function installStorage() {
  storage = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
    configurable: true,
  });
}

async function freshModule() {
  vi.resetModules();
  return import("@/hooks/useFavoriteGifs");
}

const payload = (rev: number, favorites: string[] = [], categories: GifFavoritesPayload["categories"] = []) =>
  ({ rev, favorites, categories }) satisfies GifFavoritesPayload;

describe("applyGifFavoritesOp", () => {
  it("keeps every category a subset of favourites", async () => {
    const { applyGifFavoritesOp: apply } = await freshModule();
    const ops: GifFavoritesOp[] = [
      { op: "create_category", id: "a", name: "  Reactions  " },
      { op: "create_category", id: "b", name: "Cats" },
      { op: "set_in_category", id: "a", url: "x.gif", in_category: true },
      { op: "set_in_category", id: "b", url: "x.gif", in_category: true },
    ];
    let s = ops.reduce(apply, { favorites: [], categories: [] });
    expect(s.favorites).toEqual(["x.gif"]);
    expect(s.categories[0].name).toBe("Reactions");

    s = apply(s, { op: "delete_category", id: "a" });
    expect(s.favorites).toEqual(["x.gif"]);

    s = apply(s, { op: "remove_favorite", url: "x.gif" });
    expect(s).toEqual({ favorites: [], categories: [{ id: "b", name: "Cats", urls: [] }] });
  });

  it("caps names the way the server does and ignores empty ones", async () => {
    const { applyGifFavoritesOp: apply } = await freshModule();
    const s = apply({ favorites: [], categories: [] }, { op: "create_category", id: "a", name: "é".repeat(40) });
    expect([...s.categories[0].name]).toHaveLength(32);
    expect(apply(s, { op: "rename_category", id: "a", name: "   " })).toBe(s);
  });
});

describe("the favourites store", () => {
  beforeEach(() => {
    installStorage();
    api.apiGetGifFavorites.mockReset();
    api.apiGifFavoritesOp.mockReset();
  });

  it("shows a change at once and settles on the server's answer", async () => {
    const m = await freshModule();
    api.apiGifFavoritesOp.mockResolvedValue(payload(1, ["a.gif", "other-device.gif"]));
    m.favoriteGifStore.addFavorite("a.gif");
    expect(m.favoriteGifStore.get().favorites).toEqual(["a.gif"]);
    await m.favoriteGifStore.idle();
    expect(m.favoriteGifStore.get().favorites).toEqual(["a.gif", "other-device.gif"]);
  });

  it("ignores broadcasts that are stale or that race our own change", async () => {
    const m = await freshModule();
    m.adoptGifFavorites(payload(5, ["five.gif"]));
    m.adoptGifFavorites(payload(4, ["four.gif"]));
    expect(m.favoriteGifStore.get().favorites).toEqual(["five.gif"]);

    let answer!: (p: GifFavoritesPayload) => void;
    api.apiGifFavoritesOp.mockReturnValue(new Promise((r) => (answer = r)));
    m.favoriteGifStore.addFavorite("mine.gif");
    // Sent before ours landed: describes a server without it.
    m.adoptGifFavorites(payload(6, ["five.gif", "elsewhere.gif"]));
    expect(m.favoriteGifStore.get().favorites).toEqual(["mine.gif", "five.gif"]);

    answer(payload(7, ["mine.gif", "five.gif", "elsewhere.gif"]));
    await m.favoriteGifStore.idle();
    expect(m.favoriteGifStore.get().favorites).toEqual(["mine.gif", "five.gif", "elsewhere.gif"]);
  });

  it("puts back what the server holds when it refuses a change", async () => {
    const m = await freshModule();
    m.adoptGifFavorites(payload(3, ["kept.gif"]));
    api.apiGifFavoritesOp.mockRejectedValue(new Error("You can keep at most 500 favourite GIFs"));
    api.apiGetGifFavorites.mockResolvedValue(payload(3, ["kept.gif"]));
    m.favoriteGifStore.addFavorite("one-too-many.gif");
    await m.favoriteGifStore.idle();
    await vi.waitFor(() => expect(m.favoriteGifStore.get().favorites).toEqual(["kept.gif"]));
  });

  it("imports favourites kept in this browser once, then forgets them", async () => {
    storage.set("chatter_favorite_gifs", JSON.stringify(["local.gif"]));
    storage.set("chatter_gif_categories", JSON.stringify([{ id: "c", name: "C", urls: ["local.gif"] }]));
    const m = await freshModule();
    api.apiGetGifFavorites.mockResolvedValue(payload(1, ["server.gif"]));
    api.apiGifFavoritesOp.mockResolvedValue(
      payload(2, ["server.gif", "local.gif"], [{ id: "c", name: "C", urls: ["local.gif"] }]),
    );
    await m.loadGifFavorites();
    expect(api.apiGifFavoritesOp).toHaveBeenCalledWith({
      op: "import",
      favorites: ["local.gif"],
      categories: [{ id: "c", name: "C", urls: ["local.gif"] }],
    });
    expect(m.favoriteGifStore.get().favorites).toEqual(["server.gif", "local.gif"]);
    expect(storage.size).toBe(0);
  });

  it("keeps the local copy when the import fails", async () => {
    storage.set("chatter_favorite_gifs", JSON.stringify(["local.gif"]));
    const m = await freshModule();
    api.apiGetGifFavorites.mockResolvedValue(payload(1));
    api.apiGifFavoritesOp.mockRejectedValue(new Error("offline"));
    await m.loadGifFavorites();
    expect(storage.has("chatter_favorite_gifs")).toBe(true);
  });

  it("drops a late answer meant for an account that has signed out", async () => {
    const m = await freshModule();
    let answer!: (p: GifFavoritesPayload) => void;
    api.apiGifFavoritesOp.mockReturnValue(new Promise((r) => (answer = r)));
    m.favoriteGifStore.addFavorite("theirs.gif");
    m.resetGifFavorites();
    answer(payload(9, ["theirs.gif"]));
    await Promise.resolve();
    await Promise.resolve();
    expect(m.favoriteGifStore.get().favorites).toEqual([]);
  });
});
