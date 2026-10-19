"""Chatter's app icons, drawn from the web's mark (client/public/icon.svg).

The speech bubble with its tail and three dots, on the SVG's 512 viewBox,
stroked as the SVG strokes it and supersampled 4x. Writes icon.png, the
adaptive icon's foreground, background and monochrome layers, and the
splash mark into the given folder (mobile/assets).

    python mobile/scripts/make-icons.py mobile/assets
"""
import sys
from PIL import Image, ImageDraw

SS = 4
INK = (232, 232, 232, 255)
TILE = (38, 38, 38, 255)
STROKE = 26

def mark(size, ink=INK, scale=1.0):
    """The mark alone, on transparent, the 512 viewBox fitted to `size` then scaled about the centre."""
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = n / 512 * scale
    off = n * (1 - scale) / 2
    P = lambda x, y: (off + x * k, off + y * k)
    w = max(1, round(STROKE * k))
    # The outline, as the SVG's path: corners as arcs, the tail as two
    # straight runs, stroked with round joins all the way round.
    import math
    def arc(cx, cy, a0, a1, steps=24):
        return [(cx + 48 * math.cos(math.radians(a0 + (a1 - a0) * i / steps)),
                 cy + 48 * math.sin(math.radians(a0 + (a1 - a0) * i / steps))) for i in range(steps + 1)]
    path = []
    path += arc(160, 168, 180, 270)          # top left, from (112,168) to (160,120)
    path += arc(352, 168, 270, 360)          # top right
    path += arc(352, 296, 0, 90)             # bottom right, to (352,344)
    path += [(236, 344), (160, 404), (160, 344)]  # along the bottom, the tail
    path += arc(160, 296, 90, 180)           # bottom left, to (112,296)
    path += [path[0], path[1]]               # close, and carry the join round
    d.line([P(x, y) for x, y in path], fill=ink, width=w, joint="curve")
    # The three dots.
    for cx in (196, 256, 316):
        c = P(cx, 232); r = 17 * k
        d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=ink)
    return img.resize((size, size), Image.LANCZOS)

def on(bg, size, fg):
    base = Image.new("RGBA", (size, size), bg)
    base.alpha_composite(fg)
    return base

out = sys.argv[1]
# Full icon (stores, older launchers): the tile edge to edge, the mark at the SVG's size.
on(TILE, 1024, mark(1024)).convert("RGB").save(f"{out}/icon.png")
# Adaptive icon: the mark at Android's size for a logo, about 44% of the 108dp layer.
mark(432, scale=0.72).save(f"{out}/android-icon-foreground.png")
Image.new("RGBA", (432, 432), TILE).save(f"{out}/android-icon-background.png")
mark(432, ink=(255, 255, 255, 255), scale=0.72).save(f"{out}/android-icon-monochrome.png")
# Splash: the mark alone; the splash background colour is the app's.
mark(1024, scale=0.9).save(f"{out}/splash-icon.png")
