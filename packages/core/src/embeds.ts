import type { EmbedAction, EmbedSelect } from "./api";

/**
 * A bot's rich embed, laid out the same way everywhere: its buttons and
 * select menus in the rows the bot asked for, in row order. Buttons with no
 * row share the first; selects with none go after everything else.
 */
export function embedRows<T extends EmbedAction | EmbedSelect>(items: T[] | undefined, defaultRow: number): T[][] {
  if (!items?.length) return [];
  const rows = new Map<number, T[]>();
  for (const item of items) {
    const row = item.row ?? defaultRow;
    const list = rows.get(row);
    if (list) list.push(item);
    else rows.set(row, [item]);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
}

export const embedActionRows = (actions: EmbedAction[] | undefined) => embedRows(actions, 0);
export const embedSelectRows = (selects: EmbedSelect[] | undefined) => embedRows(selects, 99);

/** The accent stripe down an embed's left edge when the bot names none. */
export const DEFAULT_EMBED_COLOR = "#5865F2";
