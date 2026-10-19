import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useChatter } from "@/state/ChatterProvider";
import { BackHandler, Pressable, StyleSheet, View } from "react-native";
import { useWindowLayout } from "@/ui/windowLayout";
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
 * web. An unfolded foldable splits at its hinge.
 */

export type PanelSide = "left" | "right";

/** Wider than this, the channel list stays on screen. */
export const SIDE_BY_SIDE_MIN_WIDTH = 720;
/** Wider than this, the member list sits beside the conversation too. */
const MEMBERS_BESIDE_MIN_WIDTH = 1040;
const LEFT_PANEL_WIDTH = 360;
const RIGHT_PANEL_WIDTH = 280;
const THREAD_PANEL_WIDTH = 400;
/** The strip at the right edge that starts a swipe for the member list: narrow
 *  enough to leave the controls at the end of a message (its "…") tappable. */
const RIGHT_EDGE = 16;

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
  /** Whether a thread opens beside the conversation (wide windows) rather
   *  than as a screen over it. */
  threadBeside: boolean;
  /** The thread pane is showing in place of the members. */
  threadOpen: boolean;
  openThread(): void;
  closeThread(): void;
}

const PanelsContext = createContext<PanelsValue | null>(null);

export function usePanels(): PanelsValue {
  const value = useContext(PanelsContext);
  if (!value) throw new Error("usePanels must be used inside <PanelLayout>");
  return value;
}

export function PanelLayout({
  left,
  right,
  thread,
  children,
}: {
  left: ReactNode;
  right: ReactNode;
  /** The open thread, beside the conversation where there is room for it. */
  thread: ReactNode;
  children: ReactNode;
}) {
  const { width, book } = useWindowLayout();
  const leftDocked = width >= SIDE_BY_SIDE_MIN_WIDTH;
  const rightDocked = width >= MEMBERS_BESIDE_MIN_WIDTH;
  const leftWidth = Math.min(LEFT_PANEL_WIDTH, Math.round(width * 0.86));
  const rightWidth = Math.min(RIGHT_PANEL_WIDTH, Math.round(width * 0.8));

  const [open, setOpen] = useState<PanelSide | null>(null);
  const [rightBeside, setRightBeside] = useState(true);
  const [threadOpen, setThreadOpen] = useState(false);
  const offset = useSharedValue(0);

  const animateTo = useCallback(
    (side: PanelSide | null) => {
      offset.set(withSpring(side === "left" ? leftWidth : side === "right" ? -rightWidth : 0, SPRING));
      setOpen(side);
    },
    [offset, leftWidth, rightWidth],
  );

  // A layout change (folding, rotating) settles whatever was half open: the
  // panel closes with this render, and the slide goes back to rest after it.
  const [layoutDocked, setLayoutDocked] = useState(leftDocked);
  if (layoutDocked !== leftDocked) {
    setLayoutDocked(leftDocked);
    setOpen(null);
  }
  useEffect(() => {
    offset.set(0);
  }, [leftDocked, offset]);

  // Another conversation (a DM opened from a profile, say) is a new list of
  // members; the old one, left open over it, would be someone else's.
  const { currentRoomId: roomId, activeThreadEventId } = useChatter();
  // The panel closes with this render; the conversation slides back after it.
  const [membersRoom, setMembersRoom] = useState(roomId);
  if (membersRoom !== roomId) {
    setMembersRoom(roomId);
    if (open === "right") setOpen(null);
  }
  useEffect(() => {
    if (offset.value < 0) offset.set(withSpring(0, SPRING));
  }, [roomId, offset]);

  // The pane shows the store's open thread. Opening one from the channel list
  // switches channel first and the thread arrives after, so the pane waits
  // for it; the store dropping a thread it had (another room or channel, the
  // thread deleted) closes the pane.
  const [paneThread, setPaneThread] = useState(activeThreadEventId);
  if (paneThread !== activeThreadEventId) {
    setPaneThread(activeThreadEventId);
    if (paneThread && !activeThreadEventId) setThreadOpen(false);
  }
  const showThread = threadOpen && !!activeThreadEventId;

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
      rightVisible: rightDocked ? rightBeside && !showThread : open === "right",
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
        if (rightDocked) {
          // The members button, with a thread open, goes back to the members.
          if (showThread) return (setThreadOpen(false), setRightBeside(true));
          return setRightBeside((v) => !v);
        }
        animateTo(open === "right" ? null : "right");
      },
      threadBeside: rightDocked,
      threadOpen: rightDocked && showThread,
      openThread: () => setThreadOpen(true),
      closeThread: () => setThreadOpen(false),
    }),
    [open, leftDocked, rightDocked, rightBeside, showThread, animateTo],
  );

  if (leftDocked) {
    return (
      <PanelsContext.Provider value={value}>
        {/* Cards on the conversation's own background, so the panels and the chat read as one surface. */}
        <View className="flex-1 flex-row bg-background">
          {/* On an unfolded foldable the channels end at the hinge and the
              conversation starts after it, so nothing sits in the crease. */}
          <View style={{ width: book ? book.x : LEFT_PANEL_WIDTH }}>{left}</View>
          {book && book.width > 0 ? <View style={{ width: book.width }} /> : null}
          <View className="flex-1 overflow-hidden">{children}</View>
          {rightDocked ? (
            showThread ? (
              // A thread wants more room than the member list (the web's ThreadPanel).
              <View style={{ width: THREAD_PANEL_WIDTH }} className="border-l border-border">
                {thread}
              </View>
            ) : rightBeside ? (
              <View style={{ width: RIGHT_PANEL_WIDTH }}>{right}</View>
            ) : null
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
      start.set(offset.value);
      fromRightEdge.set(false);
    },
    onUpdate: (e) => {
      "worklet";
      const next = start.value + e.translationX;
      const min = start.value < 0 || fromRightEdge.value ? -rightWidth : 0;
      const max = start.value < 0 ? 0 : leftWidth;
      offset.set(Math.min(max, Math.max(min, next)));
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
      start.set(offset.value);
      fromRightEdge.set(true);
    },
    onUpdate: (e) => {
      "worklet";
      offset.set(Math.min(0, Math.max(-rightWidth, start.value + e.translationX)));
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
    <View className="flex-1 bg-background">
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
