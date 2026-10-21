/**
 * The in-app notification banner: what a notification is while the app is
 * open, as a small store so the host can raise one from outside React.
 * <BannerHost /> draws it.
 *
 * One at a time, the latest in front: a burst from one conversation is one
 * banner, and another conversation's message replaces it rather than
 * stacking banners over the screen.
 */
export interface Banner {
  /** The notification's tag; a read under it takes the banner away. */
  key: string;
  title: string;
  body: string;
  icon?: string;
  onPress?: () => void;
}

type Listener = (banner: Banner | null) => void;

/** Long enough to read two lines without having to chase it. */
const DURATION_MS = 5000;

let current: Banner | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

function publish() {
  for (const l of listeners) l(current);
}

export function showBanner(banner: Banner): void {
  current = banner;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => dismissBanner(), DURATION_MS);
  publish();
}

/** Take the banner away: any banner, or only the one under `key`. */
export function dismissBanner(key?: string): void {
  if (!current || (key !== undefined && current.key !== key)) return;
  current = null;
  if (timer) clearTimeout(timer);
  timer = null;
  publish();
}

export function subscribeBanner(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}
