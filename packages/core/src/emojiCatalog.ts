/**
 * The emoji a picker offers, and how it searches and remembers them.
 *
 * Shared by the web's picker and the mobile app's, so both show the same
 * emoji in the same order, find the same ones for a search, and keep one
 * "frequently used" list (the same storage key).
 */

import { STANDARD_SHORTCODES } from "./emojiShortcodes";

/** Whether a picker value is a custom emoji (a URL) rather than a character. */
export function isCustomEmojiUrl(s: string): boolean {
  return s.startsWith("/") || s.startsWith("http");
}

export const EMOJI_CATEGORIES: Record<string, string[]> = {
  Smileys: ["😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","😚","😙","🥲","😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔","😐","😑","😶","😏","😒","🙄","😬","🤥","😌","😔","😪","🤤","😴","😷","🤒","🤕","🤢","🤮","🤧","🥵","🥶","🥴","😵","🤯","🤠","🥳","🥸","😎","🤓","🧐","😕","😟","🙁","☹️","😮","😯","😲","😳","🥺","😦","😧","😨","😰","😥","😢","😭","😱","😖","😣","😞","😓","😩","😫","🥱","😤","😠","😡","🤬","😈","👿","💀","☠️","💩","🤡","👹","👺","👻","👽","👾","🤖"],
  Gestures: ["👍","👎","👊","✊","🤛","🤜","🤞","✌️","🤟","🤘","👌","🤌","🤏","👈","👉","👆","👇","☝️","🫵","👋","🤚","🖐️","✋","🖖","🫱","🫲","🫳","🫴","👏","🙌","🤲","🤝","🙏","✍️","💅","🤳","💪","🦾","🫀","🧠","👀","👁️","👅","👄","🫦","👣"],
  Hearts: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","🩷","🩵","🩶","💔","❤️‍🔥","❤️‍🩹","💕","💞","💓","💗","💖","💘","💝","💟","💌","💋","😻","💑","👫","👬","👭"],
  Animals: ["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐻‍❄️","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐔","🐧","🐦","🦆","🦅","🦉","🦇","🐺","🐗","🐴","🦄","🐝","🐛","🦋","🐌","🐞","🦟","🕷️","🦂","🐢","🐍","🦎","🐙","🦑","🦐","🦀","🐡","🐠","🐟","🐬","🐳","🦈","🐊","🐅","🐆","🦓","🐘","🦒","🦘","🦬","🐄","🐎","🐑","🦙","🐐","🦌","🐕","🐈","🪶","🦃","🦚","🦜","🦢","🐇","🦝","🦦","🦥","🐁","🐿️","🦔","🐾"],
  Nature: ["🌱","🌲","🌳","🌴","🌵","🌾","🌿","☘️","🍀","🍁","🍂","🍃","🍄","🌺","🌻","🌹","🥀","🌷","🌸","💐","🌼","🌰","⭐","🌟","✨","💫","⚡","🔥","🌊","💧","🌍","🌎","🌏","🏔️","🌋","🏝️","🌅","🌄","🌠","🌌","🌈","☀️","🌤️","⛅","☁️","🌧️","⛈️","🌩️","❄️","☃️","⛄","🌬️","🌀","☂️","🌫️"],
  Food: ["🍕","🍔","🍟","🌭","🍿","🥓","🥚","🍳","🥞","🍞","🥐","🧀","🥗","🌮","🌯","🥪","🍖","🍗","🥙","🧆","🍱","🍜","🍝","🍣","🍤","🥟","🍦","🍧","🍨","🍩","🍪","🎂","🍰","🧁","🍫","🍬","🍭","🍷","🍸","🍹","🍺","🥂","🥃","🧋","☕","🍵","🧃","🥛","🍾","🧊","🫖","🍎","🍊","🍋","🍇","🍓","🫐","🍑","🥭","🍍","🥥","🥝","🍅","🥑","🥦","🥕","🌽","🍆","🧅","🧄","🥔"],
  Activities: ["⚽","🏀","🏈","⚾","🥎","🎾","🏐","🏉","🥏","🎱","🏓","🏸","🥊","🥋","⛳","🏹","🛹","🛼","⛸️","🛷","🥌","🎿","🏂","🏋️","🤸","🏄","🏊","🚴","🧘","🧗","🏆","🥇","🥈","🥉","🎮","🎲","♟️","🎯","🎳","🧩","🎰","🎭","🎨","🎬","🎤","🎧","🎼","🎹","🥁","🎷","🎺","🎸","🎻","🪗","🎣","🤿","🪁","🎡","🎢","🎠","🎪"],
  Travel: ["🚗","🚕","🚙","🚌","🏎️","🚓","🚑","🚒","🚐","🛻","🚚","🚜","🏍️","🛵","🚲","🛴","✈️","🚀","🛸","🚁","⛵","🚢","🚂","🚇","🚉","🚊","🚝","⚓","🚦","🗺️","🗽","🗼","🏰","🏯","🏟️","⛩️","🏛️","⛪","🕌","🏠","🏡","🏢","🏥","🏦","🏨","🏪","🏫","🏬","🏭","🌁","🌃","🌆","🌇","🌉","🏙️"],
  Objects: ["📱","💻","⌨️","🖥️","🖱️","💾","💿","📷","📸","📹","🎥","📞","☎️","📺","📻","⏰","🔋","🔌","💡","🔦","🕯️","💸","💵","💳","💎","⚖️","🧲","🔧","🔨","🛠️","🔩","🔑","🗝️","🔐","🔒","🔓","🚪","🪑","🛋️","🛏️","🛁","🧴","🧹","🧺","🧻","🧼","🧽","🛒","🎁","🎀","🎊","🎉","🎈","🧨","🪄","🔮","💈","🪞","🛍️","📚","📖","✏️","🖊️","📝","📌","📎","✂️","🗑️","🔍","🔎","🔏","💊","🩺","🩹","🧬","🔭","📡","🧪","🧫","🧯","🛢️","⚗️"],
  Symbols: ["✅","❌","❓","❗","💯","🔴","🟠","🟡","🟢","🔵","🟣","⚫","⚪","🟤","🔶","🔷","🔸","🔹","🔺","🔻","♻️","⭕","🚫","⛔","📵","🔞","🔃","🔄","🔙","🔚","🔛","🔜","🔝","🏧","♿","💤","🔔","🔕","🎵","🎶","💱","💲","Ⓜ️","🅰️","🅱️","🆎","🆑","🅾️","🆘","🆒","🆓","🆕","🆖","🆗","🆙","🆚","🈺","🈷️","✴️","🌐","💠","🔱","📛","🔰","⚜️","🏁","🚩","🎌","🏴","🏳️"],
};

/** Emoji character → the shortcode names it answers to, for search. */
const emojiToNames: Record<string, string[]> = {};
for (const [name, emoji] of Object.entries(STANDARD_SHORTCODES)) {
  if (!emojiToNames[emoji]) emojiToNames[emoji] = [];
  emojiToNames[emoji].push(name);
}

// --- Frequently Used emoji tracking via localStorage ---
const FREQ_STORAGE_KEY = "emoji_freq";
const FREQ_TOP_N = 20;

function getEmojiFrequencies(): Record<string, number> {
  try {
    const raw = localStorage.getItem(FREQ_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function recordEmojiUsage(emoji: string) {
  const freq = getEmojiFrequencies();
  freq[emoji] = (freq[emoji] || 0) + 1;
  try {
    localStorage.setItem(FREQ_STORAGE_KEY, JSON.stringify(freq));
  } catch {
    // Storage full or unavailable: the list just does not learn this one.
  }
}

export function getFrequentEmojis(): string[] {
  const freq = getEmojiFrequencies();
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, FREQ_TOP_N)
    .map(([emoji]) => emoji);
}

/**
 * What a picker shows for a search: the categories with what matches in each,
 * and the room's custom emoji that match. An empty search shows everything.
 * Names match ignoring underscores and spaces ("thumbs up" finds :thumbsup:).
 */
export function filterEmojiCatalog(
  search: string,
  roomCustomEmojis: string[] = [],
  emojiAliases: Record<string, string> = {},
): { categories: [string, string[]][]; custom: string[] } {
  const query = search.toLowerCase().replace(/[_\s]/g, "");
  const customToAliases: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(emojiAliases)) {
    (customToAliases[value] ??= []).push(name);
  }
  if (!query) return { categories: Object.entries(EMOJI_CATEGORIES), custom: roomCustomEmojis };
  const matches = (names: string[] | undefined) => !!names?.some((n) => n.replace(/_/g, "").includes(query));
  const categories = Object.entries(EMOJI_CATEGORIES)
    .map(([cat, emojis]) => [cat, emojis.filter((e) => matches([...(emojiToNames[e] || []), ...(customToAliases[e] || [])]))] as [string, string[]])
    .filter(([, emojis]) => emojis.length > 0);
  const custom = roomCustomEmojis.filter((e) => matches(customToAliases[e]));
  return { categories, custom };
}
