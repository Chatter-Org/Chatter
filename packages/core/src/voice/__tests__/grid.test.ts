import { describe, expect, it } from "vitest";
import { gridLayout, GRID_TILE_ASPECT } from "../grid";

describe("gridLayout", () => {
  it("puts two feeds side by side on a wide screen", () => {
    expect(gridLayout(2, 1600, 600)).toMatchObject({ cols: 2, rows: 1 });
  });

  it("stacks two feeds on an upright phone", () => {
    expect(gridLayout(2, 400, 800)).toMatchObject({ cols: 1, rows: 2 });
  });

  it("makes four feeds a two by two on a roughly 16:9 space", () => {
    expect(gridLayout(4, 1600, 900)).toMatchObject({ cols: 2, rows: 2 });
  });

  it("keeps tiles 16:9 and inside the space", () => {
    for (const count of [1, 2, 3, 5, 7, 12]) {
      const { cols, rows, tileWidth, tileHeight } = gridLayout(count, 1280, 720);
      expect(cols * rows).toBeGreaterThanOrEqual(count);
      expect(tileWidth / tileHeight).toBeCloseTo(GRID_TILE_ASPECT);
      expect(tileWidth * cols).toBeLessThanOrEqual(1280);
      expect(tileHeight * rows).toBeLessThanOrEqual(720);
    }
  });

  it("never leaves a whole row empty", () => {
    for (let count = 1; count <= 16; count++) {
      const { cols, rows } = gridLayout(count, 1000, 1000);
      expect(cols * (rows - 1)).toBeLessThan(count);
    }
  });

  it("gives a zero tile for nothing to lay out or no space", () => {
    expect(gridLayout(0, 800, 600).tileWidth).toBe(0);
    expect(gridLayout(3, 0, 600).tileWidth).toBe(0);
  });
});
