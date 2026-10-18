import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Join classNames, later ones winning — the web's `cn`. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
