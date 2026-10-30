/**
 * Where the camera's VRM avatars are kept: only ever on this device, never on
 * the server. The desktop app keeps them as files in a folder of its own
 * (`DesktopAvatars`, feature "avatars@1"); a browser keeps them in its
 * IndexedDB for this site. Both look the same to the camera picker.
 */
import { desktop, hasDesktopFeature } from "@/lib/desktop/bridge";

export interface StoredAvatar {
  id: string;
  /** For display: the file name without `.vrm`. */
  name: string;
  bytes: number;
}

export interface AvatarStore {
  list(): Promise<StoredAvatar[]>;
  /** Asks for files and keeps them; resolves with those added, none if the
   *  person cancels. Call it straight from a click: a browser only opens its
   *  file picker for one. */
  add(): Promise<StoredAvatar[]>;
  read(id: string): Promise<ArrayBuffer>;
  remove(id: string): Promise<void>;
  /** The desktop app only: shows its avatars folder. */
  openFolder?: () => void;
  /** Called whenever the avatars change elsewhere. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** Bigger than any avatar meant for a webcam. */
export const MAX_AVATAR_BYTES = 256 * 1024 * 1024;

const DB_NAME = "chatter_avatars";
const STORE = "avatars";
/** Other tabs of this site hear about adds and removes here. */
const CHANNEL = "chatter_avatars";

interface AvatarRecord extends StoredAvatar {
  data: Blob;
  added: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("This browser can't keep avatars."));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error ?? new Error("This browser couldn't keep the avatar."));
    tx.onabort = () => reject(tx.error ?? new Error("This browser couldn't keep the avatar."));
  });
}

/** Waits for the person to pick files, or to cancel. */
function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".vrm";
    input.multiple = true;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

function browserStore(): AvatarStore {
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  const listeners = new Set<() => void>();
  if (channel) channel.onmessage = () => listeners.forEach((l) => l());
  const changed = () => channel?.postMessage("changed");

  const list = async () => {
    const records = await transact("readonly", (store) => store.getAll() as IDBRequest<AvatarRecord[]>);
    return records
      .map(({ id, name, bytes }) => ({ id, name, bytes }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  return {
    list,
    add: async () => {
      const files = (await pickFiles()).filter((f) => f.name.toLowerCase().endsWith(".vrm"));
      if (files.length === 0) return [];
      const fitting = files.filter((f) => f.size <= MAX_AVATAR_BYTES);
      if (fitting.length === 0) throw new Error("That avatar is too large (256 MB at most).");
      const added: StoredAvatar[] = [];
      for (const file of fitting) {
        const record: AvatarRecord = {
          id: crypto.randomUUID(),
          name: file.name.slice(0, -".vrm".length) || "Avatar",
          bytes: file.size,
          data: file,
          added: Date.now(),
        };
        try {
          await transact("readwrite", (store) => store.put(record));
        } catch {
          throw new Error("There's no room left to keep that avatar in this browser.");
        }
        added.push({ id: record.id, name: record.name, bytes: record.bytes });
      }
      changed();
      return added;
    },
    read: async (id) => {
      const record = await transact("readonly", (store) => store.get(id) as IDBRequest<AvatarRecord | undefined>);
      if (!record) throw new Error("no such avatar");
      return record.data.arrayBuffer();
    },
    remove: async (id) => {
      await transact("readwrite", (store) => store.delete(id));
      changed();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

function desktopStore(): AvatarStore | null {
  const avatars = hasDesktopFeature("avatars@1") ? desktop?.avatars : undefined;
  if (!avatars) return null;
  return {
    list: () => avatars.list(),
    add: () => avatars.add(),
    read: (id) => avatars.read(id),
    remove: (id) => avatars.remove(id),
    openFolder: () => avatars.openFolder(),
    subscribe: (listener) => avatars.subscribe(listener),
  };
}

/** This device's avatars, or null where there is nowhere to keep them. An
 *  older desktop app without avatars has the browser's store, as a browser. */
export const avatarStore: AvatarStore | null =
  desktopStore() ?? (typeof indexedDB === "undefined" ? null : browserStore());
