/**
 * How a call's video tiles are laid out when everyone is shown at once.
 *
 * The shape of the space decides, not a table of counts: two feeds sit side
 * by side on a wide monitor but stacked on a phone held upright, and a fixed
 * "two means two columns" squeezes both into letterboxed strips there. So every
 * column count is tried and the one that makes the tiles largest wins.
 */

/** Tiles are drawn 16:9, the shape of a camera at the sizes we send. */
export const GRID_TILE_ASPECT = 16 / 9;

/** The gap between tiles, in the same units as the space given. */
export const GRID_GAP = 8;

export interface GridLayout {
  cols: number;
  rows: number;
  /** One tile's size, already fitted to 16:9 inside its cell. */
  tileWidth: number;
  tileHeight: number;
}

/** The layout that gives `count` tiles the largest size in `width` × `height`. */
export function gridLayout(
  count: number,
  width: number,
  height: number,
  gap: number = GRID_GAP,
): GridLayout {
  if (count <= 0 || width <= 0 || height <= 0) {
    return { cols: 1, rows: 1, tileWidth: 0, tileHeight: 0 };
  }
  let best: GridLayout = { cols: 1, rows: count, tileWidth: 0, tileHeight: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    // A layout with a whole empty row is the same as one with fewer columns.
    if ((cols - 1) * rows >= count) break;
    const cellW = (width - gap * (cols - 1)) / cols;
    const cellH = (height - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    const tileWidth = Math.min(cellW, cellH * GRID_TILE_ASPECT);
    if (tileWidth > best.tileWidth) {
      best = { cols, rows, tileWidth, tileHeight: tileWidth / GRID_TILE_ASPECT };
    }
  }
  return best;
}
