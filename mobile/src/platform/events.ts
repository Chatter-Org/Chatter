/**
 * The app's event bus: what `window` events are on the web.
 *
 * The shared core announces things through `host.emit` — a notification was
 * tapped, a forum post changed, a raw socket frame arrived — and screens that
 * care subscribe here. Listeners are called synchronously, in the order they
 * subscribed; one that throws does not stop the rest.
 */
type Listener = (detail: unknown) => void;

const listeners = new Map<string, Set<Listener>>();

export function emit(type: string, detail?: unknown): void {
  const set = listeners.get(type);
  if (!set) return;
  for (const listener of [...set]) {
    try {
      listener(detail);
    } catch (e) {
      console.warn(`events: a "${type}" listener threw`, e);
    }
  }
}

/** Subscribe; returns the unsubscribe. */
export function on<T = unknown>(type: string, listener: (detail: T) => void): () => void {
  let set = listeners.get(type);
  if (!set) listeners.set(type, (set = new Set()));
  set.add(listener as Listener);
  return () => {
    set.delete(listener as Listener);
  };
}
