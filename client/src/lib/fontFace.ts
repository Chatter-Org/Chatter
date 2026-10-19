import { isSafeNameFontUrl } from "@chatter/core/nameFont";

const registeredFonts = new Set<string>();

export function ensureFontFace(userId: string, url: string) {
  // The URL is written into a stylesheet; see isSafeNameFontUrl for why it is checked here.
  if (!isSafeNameFontUrl(url)) return;
  const key = `${userId}:${url}`;
  if (registeredFonts.has(key)) return;
  registeredFonts.add(key);
  const style = document.createElement("style");
  style.textContent = `@font-face { font-family: 'user-font-${CSS.escape(userId)}'; src: url('${url}'); }`;
  document.head.appendChild(style);
}
