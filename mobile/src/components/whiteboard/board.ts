import { AlphaType, BlendMode, ColorType, PaintStyle, Skia, StrokeCap, StrokeJoin, type SkCanvas, type SkImage } from "@shopify/react-native-skia";
import type { WhiteboardStroke } from "@chatter/core/api";

/**
 * The board's picture: the web's 2000×2000 Canvas2D bitmap, drawn the same
 * way stroke by stroke (WhiteboardArea's drawStrokeToCtx) on a Skia surface,
 * so a board looks the same here as in a browser. Strokes are kept in the
 * order they happened — a fill or the eraser depends on what came before.
 */

export const BOARD_SIZE = 2000;
const BACKGROUND = "#ffffff";

export type Tool = "pen" | "eraser" | "line" | "rect" | "circle" | "fill";

/** The stroke as it is sent: the server gives it its id, author and time. */
export type NewStroke = Pick<WhiteboardStroke, "tool" | "color" | "width" | "points" | "fill">;

function strokePaint(stroke: NewStroke, style: PaintStyle) {
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  paint.setStyle(style);
  paint.setStrokeCap(StrokeCap.Round);
  paint.setStrokeJoin(StrokeJoin.Round);
  paint.setStrokeWidth(stroke.width);
  // The eraser paints the background, as on the web, whatever colour it has.
  paint.setColor(Skia.Color(stroke.tool === "eraser" ? BACKGROUND : stroke.color));
  return paint;
}

/** Every stroke but a fill, onto `canvas` (the board's, or a preview's). */
export function drawStroke(canvas: SkCanvas, stroke: NewStroke) {
  const pts = stroke.points;
  if (!pts?.length) return;
  switch (stroke.tool) {
    case "pen":
    case "eraser": {
      // A plain polyline, unsmoothed; a single point draws nothing.
      if (pts.length < 2) return;
      const path = Skia.PathBuilder.Make().moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
      canvas.drawPath(path.build(), strokePaint(stroke, PaintStyle.Stroke));
      return;
    }
    case "line": {
      if (pts.length < 2) return;
      const [a, b] = [pts[0], pts[pts.length - 1]];
      canvas.drawLine(a[0], a[1], b[0], b[1], strokePaint(stroke, PaintStyle.Stroke));
      return;
    }
    case "rect":
    case "circle": {
      // Both fitted to the box between the two corners.
      if (pts.length < 2) return;
      const [a, b] = [pts[0], pts[pts.length - 1]];
      const rect = Skia.XYWHRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      const paint = strokePaint(stroke, stroke.fill ? PaintStyle.Fill : PaintStyle.Stroke);
      if (stroke.tool === "rect") canvas.drawRect(rect, paint);
      else canvas.drawOval(rect, paint);
      return;
    }
  }
}

function hexColor(color: string): [number, number, number] {
  const n = (i: number) => parseInt(color.slice(i, i + 2), 16) || 0;
  return [n(1), n(3), n(5)];
}

export class Board {
  private readonly surface = Skia.Surface.Make(BOARD_SIZE, BOARD_SIZE)!;
  strokes: WhiteboardStroke[] = [];
  /** The picture as of the last change. */
  image: SkImage;

  constructor() {
    this.surface.getCanvas().clear(Skia.Color(BACKGROUND));
    this.image = this.snapshot();
  }

  /** Everything again, from a blank board: after loading, an undo, a clear. */
  replaceAll(strokes: WhiteboardStroke[]) {
    this.strokes = strokes;
    const canvas = this.surface.getCanvas();
    canvas.clear(Skia.Color(BACKGROUND));
    for (const s of strokes) this.paint(s);
    this.image = this.snapshot();
  }

  /** One more, on top. */
  add(stroke: WhiteboardStroke) {
    this.strokes.push(stroke);
    this.paint(stroke);
    this.image = this.snapshot();
  }

  remove(strokeId: string): boolean {
    const i = this.strokes.findIndex((s) => s.stroke_id === strokeId);
    if (i < 0) return false;
    this.replaceAll(this.strokes.filter((_, j) => j !== i));
    return true;
  }

  /** The picture as a PNG, for sending into the conversation. */
  png(): Uint8Array {
    return this.image.encodeToBytes();
  }

  private snapshot(): SkImage {
    this.surface.flush();
    return this.surface.makeImageSnapshot();
  }

  private paint(stroke: WhiteboardStroke) {
    if (stroke.tool === "fill") this.floodFill(stroke);
    else drawStroke(this.surface.getCanvas(), stroke);
  }

  /** The web's fill: from the seed, every 4-connected pixel of exactly the
   *  seed's colour (no tolerance, so antialiased edges stay) takes the fill. */
  private floodFill(stroke: WhiteboardStroke) {
    const seed = stroke.points?.[0];
    if (!seed) return;
    const W = BOARD_SIZE;
    const px = Math.min(W - 1, Math.max(0, Math.floor(seed[0])));
    const py = Math.min(W - 1, Math.max(0, Math.floor(seed[1])));
    const info = { width: W, height: W, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul };
    const pixels = this.snapshot().readPixels(0, 0, info);
    if (!(pixels instanceof Uint8Array)) return;
    const [fR, fG, fB] = hexColor(stroke.color);
    const at = (py * W + px) * 4;
    const [tR, tG, tB, tA] = [pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]];
    if (tR === fR && tG === fG && tB === fB && tA === 255) return;

    const visited = new Uint8Array(W * W);
    const queue = new Int32Array(W * W);
    let head = 0;
    let tail = 0;
    queue[tail++] = py * W + px;
    visited[py * W + px] = 1;
    while (head < tail) {
      const p = queue[head++];
      const o = p * 4;
      if (pixels[o] !== tR || pixels[o + 1] !== tG || pixels[o + 2] !== tB || pixels[o + 3] !== tA) continue;
      pixels[o] = fR;
      pixels[o + 1] = fG;
      pixels[o + 2] = fB;
      pixels[o + 3] = 255;
      // Four million pixels: no allocation in here.
      const x = p % W;
      if (x > 0 && !visited[p - 1]) {
        visited[p - 1] = 1;
        queue[tail++] = p - 1;
      }
      if (x < W - 1 && !visited[p + 1]) {
        visited[p + 1] = 1;
        queue[tail++] = p + 1;
      }
      if (p >= W && !visited[p - W]) {
        visited[p - W] = 1;
        queue[tail++] = p - W;
      }
      if (p < W * (W - 1) && !visited[p + W]) {
        visited[p + W] = 1;
        queue[tail++] = p + W;
      }
    }
    const filled = Skia.Image.MakeImage(info, Skia.Data.fromBytes(pixels), W * 4);
    if (!filled) return;
    const paint = Skia.Paint();
    paint.setBlendMode(BlendMode.Src);
    this.surface.getCanvas().drawImage(filled, 0, 0, paint);
  }
}
