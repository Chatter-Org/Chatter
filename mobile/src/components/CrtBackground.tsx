import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Svg, { Defs, Pattern, RadialGradient, Rect, Stop } from "react-native-svg";
import { LOGIN_SENTENCES } from "@chatter/core/loginScreen";

/**
 * The sign-in screen's backdrop — the web's HalftoneBackground: an old
 * terminal's dark glass with scanlines and a vignette, where lines of chat
 * type themselves out, hold, and fade. They keep to the space above and below
 * the sign-in card.
 */

const FONT_SIZE = 17;
const MAX_ACTIVE = 3;
const SPAWN_INTERVAL_MS = 1800;
const MAX_OPACITY = 0.35;
const FRAME_MS = 1000 / 30;
const FADE_STEP = MAX_OPACITY / 30;
/** JetBrains Mono's advance is 0.6em. */
const CHAR_WIDTH = FONT_SIZE * 0.6;

interface Line {
  id: number;
  text: string;
  x: number;
  y: number;
  shown: number;
  phase: "typing" | "hold" | "fadeout";
  hold: number;
  opacity: number;
}

/** A line as one frame draws it, flicker included. */
interface Drawn {
  id: number;
  text: string;
  x: number;
  y: number;
  typing: boolean;
  opacity: number;
}

/** The part of the screen to keep clear: the sign-in card, top to bottom. */
export interface CrtClearance {
  top: number;
  bottom: number;
}

export function CrtBackground({ clear }: { clear?: CrtClearance }) {
  const { width, height } = useWindowDimensions();
  // The lines live in refs and change in place every tick; each frame hands
  // the screen a copy to draw.
  const [frame, setFrame] = useState<Drawn[]>([]);
  const lines = useRef<Line[]>([]);
  const nextId = useRef(1);
  const lastSpawn = useRef(0);
  const dip = useRef(0);

  useEffect(() => {
    const spawn = (now: number) => {
      if (lines.current.length >= MAX_ACTIVE || now - lastSpawn.current < SPAWN_INTERVAL_MS) return;
      lastSpawn.current = now;
      const showing = new Set(lines.current.map((l) => l.text));
      const fits = LOGIN_SENTENCES.filter((s) => !showing.has(s) && s.length * CHAR_WIDTH < width - 32);
      if (fits.length === 0) return;
      const text = fits[Math.floor(Math.random() * fits.length)];
      // Lines go in the bands above and below the card, never across it (the
      // web keeps them out of the middle the same way).
      const card = clear ?? { top: height * 0.2, bottom: height * 0.8 };
      const bands = [
        [48, card.top - FONT_SIZE * 2],
        [card.bottom + FONT_SIZE, height - 96],
      ].filter(([a, b]) => b - a > FONT_SIZE);
      if (bands.length === 0) return;
      const band = bands[Math.floor(Math.random() * bands.length)];
      const textWidth = text.length * CHAR_WIDTH;
      lines.current.push({
        id: nextId.current++,
        text,
        x: 16 + Math.random() * Math.max(0, width - 32 - textWidth),
        y: band[0] + Math.random() * (band[1] - band[0]),
        shown: 0,
        phase: "typing",
        hold: 0,
        opacity: 0,
      });
    };

    const timer = setInterval(() => {
      const now = Date.now();
      if (dip.current > 0) dip.current = Math.max(0, dip.current - 0.08);
      else if (Math.random() < 0.005) dip.current = 0.2 + Math.random() * 0.25;
      for (let i = lines.current.length - 1; i >= 0; i--) {
        const l = lines.current[i];
        if (l.phase === "typing") {
          l.shown += 1;
          l.opacity = MAX_OPACITY * Math.min((l.shown / l.text.length) * 1.5, 1);
          if (l.shown >= l.text.length) {
            l.phase = "hold";
            l.opacity = MAX_OPACITY;
            l.hold = Math.floor(30 * (1.3 + Math.random() * 1.7));
          }
        } else if (l.phase === "hold") {
          if (--l.hold <= 0) l.phase = "fadeout";
        } else {
          l.opacity -= FADE_STEP;
          if (l.opacity <= 0) lines.current.splice(i, 1);
        }
      }
      spawn(now);
      const flicker = 1 - dip.current;
      setFrame(
        lines.current.map((l) => ({
          id: l.id,
          text: l.text.slice(0, l.shown),
          x: l.x,
          y: l.y,
          typing: l.phase === "typing",
          opacity: l.opacity * (0.88 + Math.random() * 0.12) * flicker,
        })),
      );
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [width, height, clear]);

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: "#0a0a0a" }]} pointerEvents="none">
      {frame.map((l) => {
        const o = l.opacity;
        return (
          <Text
            key={l.id}
            style={{
              position: "absolute",
              left: l.x,
              top: l.y,
              fontFamily: "JetBrainsMono_400Regular",
              fontSize: FONT_SIZE,
              color: `rgba(220, 230, 255, ${o})`,
              textShadowColor: `rgba(180, 210, 255, ${o * 0.8})`,
              textShadowRadius: 8 * (o / MAX_OPACITY),
            }}
          >
            {l.text}
            {l.typing ? <Text style={{ color: `rgba(200, 220, 255, ${o * 0.7})` }}>▏</Text> : null}
          </Text>
        );
      })}
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <Pattern id="scanlines" width="4" height="2" patternUnits="userSpaceOnUse">
            <Rect width="4" height="1" fill="#000" fillOpacity={0.16} />
          </Pattern>
          <RadialGradient id="vignette" cx="50%" cy="50%" r="75%">
            <Stop offset="0.2" stopColor="#000" stopOpacity={0} />
            <Stop offset="0.5" stopColor="#000" stopOpacity={0.105} />
            <Stop offset="0.75" stopColor="#000" stopOpacity={0.315} />
            <Stop offset="1" stopColor="#000" stopOpacity={0.7} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#scanlines)" />
        <Rect width="100%" height="100%" fill="url(#vignette)" />
      </Svg>
    </View>
  );
}
