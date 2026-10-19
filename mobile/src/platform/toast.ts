/**
 * In-app toasts, the native counterpart of the web's sonner.
 *
 * A small store rather than a component API, so code outside React (the
 * shared core, through host.toast) can raise one. <ToastHost /> renders them.
 */
export interface Toast {
  id: number;
  message: string;
  description?: string;
  tone?: "default" | "error";
}

type Listener = (toasts: Toast[]) => void;

/** Long enough to read two lines; errors linger a little longer. */
const DURATION_MS = { default: 3500, error: 5000 };
/** More than this and the oldest make way. */
const MAX_VISIBLE = 3;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function publish() {
  for (const l of listeners) l(toasts);
}

export function showToast(toast: Omit<Toast, "id">): void {
  const id = nextId++;
  toasts = [...toasts, { ...toast, id }].slice(-MAX_VISIBLE);
  publish();
  setTimeout(() => dismissToast(id), DURATION_MS[toast.tone ?? "default"]);
}

export function dismissToast(id: number): void {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  publish();
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}
