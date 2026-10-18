import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Join classNames, later ones winning — the web's `cn`. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// On the web a weight picks a face of the one font; on a phone each weight of
// JetBrains Mono is its own family. Shared recipes say `font-medium` or
// `font-bold`, so text classes are translated before they reach a <Text>.
const WEIGHT_FAMILY: Record<string, string> = {
  "font-normal": "font-mono",
  "font-medium": "font-mono-medium",
  "font-semibold": "font-mono-bold",
  "font-bold": "font-mono-bold",
  "font-extrabold": "font-mono-bold",
};

/** Text classes, with web font weights turned into the app's font families. */
export function textClasses(...inputs: ClassValue[]): string {
  return cn(...inputs)
    .split(" ")
    .map((c) => WEIGHT_FAMILY[c] ?? c)
    .join(" ");
}
