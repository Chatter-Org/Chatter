/**
 * How Chatter's controls look, shared by the web and the mobile app.
 *
 * Both draw with Tailwind classes over the same theme tokens (the web with
 * Tailwind, the app with Uniwind), so the look of a button or a badge can be
 * written once. What cannot be shared stays with each platform:
 *
 *   - layout: the web's `inline-flex` is a native row's `flex-row`;
 *   - interaction: hover and focus rings on the web, a pressed state on a
 *     phone;
 *   - text: on the web a button's colour and font reach its label by
 *     inheritance; React Native has none, so each recipe keeps the classes for
 *     the box (`box`) apart from the ones for the words in it (`text`).
 *
 * The web's components/ui files build their class lists from these, so a
 * change here changes both apps.
 */

export interface Look {
  /** Classes for the element itself: background, border, radius, size. */
  box: string;
  /** Classes for its label: colour, size, weight. */
  text: string;
}

const look = (box: string, text = ""): Look => ({ box, text });

/** Join looks into one class list — what the web, where text inherits, uses. */
export function both(...looks: (Look | undefined)[]): string {
  return looks
    .flatMap((l) => (l ? [l.box, l.text] : []))
    .filter(Boolean)
    .join(" ");
}

// ─── Button ──────────────────────────────────────────────────────────────────

export const button = {
  base: look("rounded-md", "text-sm font-medium"),
  variant: {
    default: look("bg-primary", "text-primary-foreground"),
    destructive: look("bg-destructive", "text-white"),
    outline: look("border bg-background"),
    secondary: look("bg-secondary", "text-secondary-foreground"),
    ghost: look(""),
    link: look("", "text-primary"),
  },
  size: {
    default: look("h-9 px-4"),
    xs: look("h-6 gap-1 rounded-md px-2", "text-xs"),
    sm: look("h-8 rounded-md gap-1.5 px-3"),
    lg: look("h-10 rounded-md px-6"),
    icon: look("size-9"),
    "icon-xs": look("size-6 rounded-md"),
    "icon-sm": look("size-8"),
    "icon-lg": look("size-10"),
  },
} as const;

export type ButtonVariant = keyof typeof button.variant;
export type ButtonSize = keyof typeof button.size;

// ─── Badge ───────────────────────────────────────────────────────────────────

export const badge = {
  base: look("rounded-full border border-transparent px-2 py-0.5", "text-xs font-medium"),
  variant: {
    default: look("bg-primary", "text-primary-foreground"),
    secondary: look("bg-secondary", "text-secondary-foreground"),
    destructive: look("bg-destructive", "text-white"),
    outline: look("border-border", "text-foreground"),
    ghost: look(""),
    link: look("", "text-primary"),
  },
} as const;

export type BadgeVariant = keyof typeof badge.variant;

// ─── Text input ──────────────────────────────────────────────────────────────

export const input = look("border-input h-9 rounded-md border bg-transparent px-3 py-1", "text-base");

// ─── Toggle (and the segmented control built from toggles) ───────────────────

export const toggle = {
  base: look("rounded-md", "text-sm font-medium"),
  on: look("bg-accent", "text-accent-foreground"),
  variant: {
    default: look("bg-transparent"),
    outline: look("border border-input bg-transparent"),
  },
  size: {
    default: look("h-9 px-2 min-w-9"),
    sm: look("h-8 px-1.5 min-w-8"),
    lg: look("h-10 px-2.5 min-w-10"),
  },
} as const;

/**
 * A two-or-more-way switch, as the sidebar's DMs / Rooms: a muted track with
 * the chosen segment raised on the background colour.
 */
export const segmented = {
  track: look("rounded-md border border-border p-0.5 bg-muted"),
  item: look("h-7 rounded-sm", "text-xs"),
  on: look("bg-background shadow-sm", "text-foreground"),
  off: look("", "text-muted-foreground"),
} as const;

// ─── Card ────────────────────────────────────────────────────────────────────

export const card = look("bg-card rounded-xl border py-6 shadow-sm", "text-card-foreground");
