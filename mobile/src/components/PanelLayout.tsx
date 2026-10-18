import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BackHandler, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import * as Haptics from "expo-haptics";

/**
 * The three-panel shell: servers and channels on the left, the conversation
 * in the middle, members on the right.
 *
 * On a phone the conversation is the screen and the panels sit behind it: a
 * swipe right anywhere pushes it aside to show the channels, a swipe in from
 * the right edge shows the members, a tap on the conversation or Back puts it
 * back. A leftward swipe that does not start at the edge is left alone, so a
 * message can be swiped to reply.
 *
 * With room to spare — an open foldable, a tablet, landscape — the channels
 * stay beside the conversation and the members open beside it too, as on the
 * web.
 */

export type PanelSide = "left" | "right";

/** Wider than this, the channel list stays on screen. */
export const SIDE_BY_SIDE_MIN_WIDTH = 720;
/** Wider than this, the member list sits beside the conversation too. */
const MEMBERS_BESIDE_MIN_WIDTH = 1040;
const LEFT_PANEL_WIDTH = 340;
const RIGHT_PANEL_WIDTH = 280;
/** The strip at the right edge that starts a swipe for the member list. */
const RIGHT_EDGE = 28;

const SPRING = { damping: 26, stiffness: 260, mass: 0.9, overshootClamping: true } as const;

interface PanelsValue {
  /** The panel showing over the conversation on a phone; null when none is. */
  open: PanelSide | null;
  /** Whether the left panel is always on screen (wide layouts). */
  leftDocked: boolean;
  /** Whether the right panel can sit beside the conversation. */
  rightDocked: boolean;
  rightVisible: boolean;
  show(side: PanelSide): void;
  close(): void;
  toggleRight(): void;
}

const PanelsContext = createContext<PanelsValue | null>(null);

export function usePanels(): PanelsValue {
  const value = useContext(PanelsContext);
  if (!value) throw new Error("usePanels must be used inside <PanelLayout>");
  return value;
}

export function PanelLayout({ left, right, children }: { left: ReactNode; right: ReactNode; children: ReactNode }) {
  const { width } = useWindowDimensions();
  const leftDocked = width >= SIDE_BY_SIDE_MIN_WIDTH;
  const rightDocked = width >= MEMBERS_BESIDE_MIN_WIDTH;
  const leftWidth = Math.min(LEFT_PANEL_WIDTH, Math.round(width * 0.86));
  const rightWidth = Math.min(RIGHT_PANEL_WIDTH, Math.round(width * 0.8));

  const [open, setOpen] = useState<PanelSide | null>(null);
  const [rightBeside, setRightBeside] = useState(true);
  const offset = useSharedValue(0);

  const animateTo = useCallback(
    (side: PanelSide | null) => {
      offset.value = withSpring(side === "left" ? leftWidth : side === "right" ? -rightWidth : 0, SPRING);
      setOpen(side);
    },
    [offset, leftWidth, rightWidth],
  );

  // A layout change (folding, rotating) settles whatever was half open.
  useEffect(() => {
    offset.value = 0;
    setOpen(null);
  }, [leftDocked, offset]);

  // Back closes an open panel before it leaves the screen.
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      animateTo(null);
      return true;
    });
    return () => sub.remove();
  }, [open, animateTo]);

  const value = useMemo<PanelsValue>(
    () => ({
      open,
      leftDocked,
      rightDocked,
      rightVisible: rightDocked ? rightBeside : open === "right",
      show: (side) => {
        if (side === "left" && leftDocked) return;
        if (side === "right" && rightDocked) return setRightBeside(true);
        void Haptics.selectionAsync().catch(() => {});
        animateTo(side);
      },
      close: () => {
        if (!leftDocked || open) animateTo(null);
      },
      toggleRight: () => {
        if (rightDocked) return setRightBeside((v) => !v);
        animateTo(open === "right" ? null : "right");
      },
    }),
    [open, leftDocked, rightDocked, rightBeside, animateTo],
  );

  if (leftDocked) {
    return (
      <PanelsContext.Provider value={value}>
        <View className="flex-1 flex-row bg-background">
          <View style={{ width: LEFT_PANEL_WIDTH }}>{left}</View>
          <View className="flex-1">{children}</View>
          {rightDocked ? (
            rightBeside ? <View style={{ width: RIGHT_PANEL_WIDTH }}>{right}</View> : null
          ) : (
            <Drawer side="right" open={open === "right"} width={rightWidth} onClose={() => animateTo(null)}>
              {right}
            </Drawer>
          )}
        </View>
      </PanelsContext.Provider>
    );
  }

  return (
    <PanelsContext.Provider value={value}>
      <PushLayout
        offset={offset}
        leftWidth={leftWidth}
        rightWidth={rightWidth}
        open={open}
        onSettle={animateTo}
        left={left}
        right={right}
      >
        {children}
      </PushLayout>
    </PanelsContext.Provider>
  );
}

/** The phone layout: the conversation slides to uncover a panel behind it. */
function PushLayout({
  offset,
  leftWidth,
  rightWidth,
  open,
  onSettle,
  left,
  right,
  children,
}: {
  offset: SharedValue<number>;
  leftWidth: number;
  rightWidth: number;
  open: PanelSide | null;
  onSettle(side: PanelSide | null): void;
  left: ReactNode;
  right: ReactNode;
  children: ReactNode;
}) {
  const start = useSharedValue(0);
  const fromRightEdge = useSharedValue(false);
  // Closed, only a rightward swipe is ours; a leftward one belongs to the
  // message under the finger (swipe to reply) unless it began at the edge.
  const leftActivation = useDerivedValue<number>(() => (open ? -12 : -100000), [open]);

  const settle = (velocity: number) => {
    "worklet";
    const x = offset.value;
    let target: PanelSide | null = null;
    if (x > 0) target = velocity > 500 || (velocity > -500 && x > leftWidth / 2) ? "left" : null;
    else if (x < 0) target = velocity < -500 || (velocity < 500 && -x > rightWidth / 2) ? "right" : null;
    scheduleOnRN(onSettle, target);
  };

  const pan = usePanGesture({
    activeOffsetX: [leftActivation, 12],
    failOffsetY: [-14, 14],
    onBegin: () => {
      "worklet";
      start.value = offset.value;
      fromRightEdge.value = false;
    },
    onUpdate: (e) => {
      "worklet";
      const next = start.value + e.translationX;
      const min = start.value < 0 || fromRightEdge.value ? -rightWidth : 0;
      const max = start.value < 0 ? 0 : leftWidth;
      offset.value = Math.min(max, Math.max(min, next));
    },
    onDeactivate: (e) => {
      "worklet";
      settle(e.velocityX);
    },
  });

  const edgePan = usePanGesture({
    activeOffsetX: [-12, 100000],
    failOffsetY: [-14, 14],
    onBegin: () => {
      "worklet";
      start.value = offset.value;
      fromRightEdge.value = true;
    },
    onUpdate: (e) => {
      "worklet";
      offset.value = Math.min(0, Math.max(-rightWidth, start.value + e.translationX));
    },
    onDeactivate: (e) => {
      "worklet";
      settle(e.velocityX);
    },
  });

  const centerStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));
  const leftStyle = useAnimatedStyle(() => ({
    opacity: offset.value > 0 ? 1 : 0,
    transform: [{ translateX: interpolate(offset.value, [0, leftWidth], [-leftWidth * 0.25, 0], "clamp") }],
  }));
  const rightStyle = useAnimatedStyle(() => ({
    opacity: offset.value < 0 ? 1 : 0,
    transform: [{ translateX: interpolate(offset.value, [-rightWidth, 0], [0, rightWidth * 0.25], "clamp") }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(Math.abs(offset.value), [0, Math.max(leftWidth, rightWidth)], [0, 0.35], "clamp"),
  }));

  return (
    <View className="flex-1 bg-sidebar">
      <Animated.View style={[styles.panel, { left: 0, width: leftWidth }, leftStyle]} pointerEvents={open === "left" ? "auto" : "none"}>
        {left}
      </Animated.View>
      <Animated.View style={[styles.panel, { right: 0, width: rightWidth }, rightStyle]} pointerEvents={open === "right" ? "auto" : "none"}>
        {right}
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={[StyleSheet.absoluteFill, centerStyle]} className="bg-background">
          {children}
          {open ? (
            <Animated.View style={[StyleSheet.absoluteFill, scrimStyle]} className="bg-black">
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={() => onSettle(null)}
                accessibilityLabel="Close panel"
                accessibilityRole="button"
              />
            </Animated.View>
          ) : (
            <GestureDetector gesture={edgePan}>
              <View style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: RIGHT_EDGE }} />
            </GestureDetector>
          )}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

/** A panel sliding over the content from one side (medium widths). */
function Drawer({
  side,
  open,
  width,
  onClose,
  children,
}: {
  side: PanelSide;
  open: boolean;
  width: number;
  onClose(): void;
  children: ReactNode;
}) {
  const progress = useDerivedValue(() => withSpring(open ? 1 : 0, SPRING), [open]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - progress.value) * (side === "right" ? width : -width) }],
  }));
  const scrim = useAnimatedStyle(() => ({ opacity: progress.value * 0.35 }));
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? "auto" : "none"}>
      <Animated.View style={[StyleSheet.absoluteFill, scrim]} className="bg-black">
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close panel" />
      </Animated.View>
      <Animated.View style={[styles.panel, side === "right" ? { right: 0 } : { left: 0 }, { width }, style]}>{children}</Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { position: "absolute", top: 0, bottom: 0 },
});
