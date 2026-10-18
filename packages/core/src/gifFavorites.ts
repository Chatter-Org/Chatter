/**
 * Favourite GIFs and their categories, held by the account — one store per
 * app, shared by the web and the phone. Each wraps `subscribeGifFavorites` /
 * `getGifFavorites` in its own hook.
 */
import { apiGetGifFavorites, apiGifFavoritesOp, type GifFavoritesOp, type GifFavoritesPayload } from "./api";
import { host } from "./platform";

export const MAX_CATEGORY_NAME = 32;

/** Where favourites lived before the account held them. Read once, imported,
 *  then removed. */
const LEGACY_FAVORITES_KEY = "chatter_favorite_gifs";
const LEGACY_CATEGORIES_KEY = "chatter_gif_categories";

/**
 * A user-made folder of favourite GIFs. A GIF can sit in several, and every
 * GIF in one is also a favourite — unfavouriting takes it out of them all, so
 * a category can never hold something the Favorites list does not.
 */
export interface GifCategory {
  id: string;
  name: string;
  urls: string[];
}

export interface FavoritesState {
  favorites: string[];
  categories: GifCategory[];
}

const EMPTY: FavoritesState = { favorites: [], categories: [] };

/** Trimmed and capped exactly as the server does it, so an optimistic name is
 *  the name that comes back. Counted in code points, like Rust's `chars()`. */
function cleanName(name: string): string {
  return [...name.trim()].slice(0, MAX_CATEGORY_NAME).join("").trimEnd();
}

/**
 * One operation applied locally — the optimistic half of what
 * `backend/routes/gif_favorites.rs` does in `apply_op`; change both together.
 * Limits and url checks are left to the server: a refusal reverts to what it
 * holds rather than being predicted here.
 */
export function applyGifFavoritesOp(s: FavoritesState, op: GifFavoritesOp): FavoritesState {
  const favorite = (favorites: string[], url: string) =>
    favorites.includes(url) ? favorites : [url, ...favorites];
  switch (op.op) {
    case "add_favorite":
      return { ...s, favorites: favorite(s.favorites, op.url) };
    case "remove_favorite":
      return {
        favorites: s.favorites.filter((u) => u !== op.url),
        categories: s.categories.map((c) =>
          c.urls.includes(op.url) ? { ...c, urls: c.urls.filter((u) => u !== op.url) } : c,
        ),
      };
    case "create_category": {
      const name = cleanName(op.name);
      if (!name || s.categories.some((c) => c.id === op.id)) return s;
      return { ...s, categories: [...s.categories, { id: op.id, name, urls: [] }] };
    }
    case "rename_category": {
      const name = cleanName(op.name);
      if (!name) return s;
      return { ...s, categories: s.categories.map((c) => (c.id === op.id ? { ...c, name } : c)) };
    }
    case "delete_category":
      return { ...s, categories: s.categories.filter((c) => c.id !== op.id) };
    case "set_in_category": {
      if (!s.categories.some((c) => c.id === op.id)) return s;
      return {
        favorites: op.in_category ? favorite(s.favorites, op.url) : s.favorites,
        categories: s.categories.map((c) => {
          if (c.id !== op.id || c.urls.includes(op.url) === op.in_category) return c;
          return {
            ...c,
            urls: op.in_category ? [op.url, ...c.urls] : c.urls.filter((u) => u !== op.url),
          };
        }),
      };
    }
    case "import":
      // Merging is the server's to do; its answer replaces this anyway.
      return s;
  }
}

// One store for the whole page, so a star toggled on a message and the
// picker's Favorites tab can never disagree about what is favourited.
let state: FavoritesState = EMPTY;
/** The server revision `state` was last brought level with; -1 before any. */
let rev = -1;
/** Operations sent and not yet answered. While any are, a broadcast is
 *  ignored — it describes the server before our own change landed, and the
 *  last answer will carry everything it does and more. */
let inFlight = 0;
let lastAnswer: GifFavoritesPayload | null = null;
let failed = false;
/** Requests run one after another, so the server applies them in the order
 *  they were made and the last answer is the newest state. */
let queue: Promise<void> = Promise.resolve();
/** Bumped by `resetGifFavorites`, so an answer meant for the account that just
 *  signed out never lands in the next one's store. */
let generation = 0;

const listeners = new Set<() => void>();

function setState(next: FavoritesState) {
  if (next === state) return;
  state = next;
  listeners.forEach((l) => l());
}

/** Subscribe to changes; returns the unsubscribe. */
export function subscribeGifFavorites(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What is held now. A new object on every change, the same one otherwise. */
export function getGifFavorites(): FavoritesState {
  return state;
}

function toState(payload: GifFavoritesPayload): FavoritesState {
  return {
    favorites: Array.isArray(payload.favorites) ? payload.favorites : [],
    categories: Array.isArray(payload.categories) ? payload.categories : [],
  };
}

/** Adopt the server's copy — from the socket, a fetch, or an import — unless
 *  it is older than what is held or our own changes are still on the way. */
export function adoptGifFavorites(payload: GifFavoritesPayload) {
  if (inFlight > 0 || typeof payload?.rev !== "number" || payload.rev <= rev) return;
  rev = payload.rev;
  setState(toState(payload));
}

function send(op: GifFavoritesOp) {
  setState(applyGifFavoritesOp(state, op));
  inFlight += 1;
  const gen = generation;
  queue = queue.then(async () => {
    try {
      const answer = await apiGifFavoritesOp(op);
      if (gen === generation) lastAnswer = answer;
    } catch (err) {
      if (gen !== generation) return;
      failed = true;
      host.toastError(err instanceof Error ? err.message : "Failed to save favourite GIFs");
    } finally {
      if (gen === generation) {
        inFlight -= 1;
        if (inFlight === 0) settle();
      }
    }
  });
}

/** Everything sent has been answered: take the server's word for the result. */
function settle() {
  const answer = lastAnswer;
  const refused = failed;
  lastAnswer = null;
  failed = false;
  // A refusal leaves an optimistic change on screen that the server does not
  // hold, and the last answer (if any) predates later sends — fetch the truth.
  if (refused) {
    rev = -1;
    void loadGifFavorites();
  } else if (answer && answer.rev >= rev) {
    rev = answer.rev;
    setState(toState(answer));
  }
}

function readLegacy(): { favorites: string[]; categories: GifCategory[] } | null {
  try {
    const favRaw = localStorage.getItem(LEGACY_FAVORITES_KEY);
    const catRaw = localStorage.getItem(LEGACY_CATEGORIES_KEY);
    if (favRaw === null && catRaw === null) return null;
    const favs: unknown = favRaw ? JSON.parse(favRaw) : [];
    const cats: unknown = catRaw ? JSON.parse(catRaw) : [];
    return {
      favorites: Array.isArray(favs) ? favs.filter((u): u is string => typeof u === "string") : [],
      categories: Array.isArray(cats)
        ? cats.filter(
            (c): c is GifCategory =>
              !!c && typeof c.id === "string" && typeof c.name === "string" && Array.isArray(c.urls),
          )
        : [],
    };
  } catch {
    return null;
  }
}

function forgetLegacy() {
  try {
    localStorage.removeItem(LEGACY_FAVORITES_KEY);
    localStorage.removeItem(LEGACY_CATEGORIES_KEY);
  } catch {
    // Blocked storage: the import is a merge, so running it again is harmless.
  }
}

/**
 * Fetch the account's favourites, and on the first load in a browser that
 * kept some locally, merge those in. The local copy is removed only once the
 * server has them, so a failed import is retried on the next load.
 */
export async function loadGifFavorites() {
  const gen = generation;
  try {
    const payload = await apiGetGifFavorites();
    if (gen !== generation) return;
    adoptGifFavorites(payload);
  } catch {
    return;
  }
  const legacy = readLegacy();
  if (!legacy) return;
  if (legacy.favorites.length === 0 && legacy.categories.length === 0) {
    forgetLegacy();
    return;
  }
  try {
    const merged = await apiGifFavoritesOp({ op: "import", ...legacy });
    forgetLegacy();
    if (gen === generation) adoptGifFavorites(merged);
  } catch {
    // Kept for the next load.
  }
}

/** Sign-out, or a different account signing in: nothing of the last one stays. */
export function resetGifFavorites() {
  generation += 1;
  rev = -1;
  inFlight = 0;
  lastAnswer = null;
  failed = false;
  queue = Promise.resolve();
  setState(EMPTY);
}

function newCategoryId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const gifFavoriteActions = {
  addFavorite(url: string) {
    send({ op: "add_favorite", url });
  },
  removeFavorite(url: string) {
    send({ op: "remove_favorite", url });
  },
  /** Returns the new category's id, or null for an empty name. */
  createCategory(name: string): string | null {
    if (!cleanName(name)) return null;
    const id = newCategoryId();
    send({ op: "create_category", id, name });
    return id;
  },
  renameCategory(id: string, name: string) {
    if (cleanName(name)) send({ op: "rename_category", id, name });
  },
  /** Deletes the category only; its GIFs stay favourites. */
  deleteCategory(id: string) {
    send({ op: "delete_category", id });
  },
  /** Puts a GIF in or takes it out of a category, favouriting it on the way in. */
  setInCategory(id: string, url: string, inCategory: boolean) {
    send({ op: "set_in_category", id, url, in_category: inCategory });
  },
};

/** The same store outside React — for tests. */
export const favoriteGifStore = {
  get: getGifFavorites,
  ...gifFavoriteActions,
  /** Resolves once every queued request has been answered. */
  idle: () => queue,
};
