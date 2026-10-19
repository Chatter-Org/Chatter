import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { LucideProps } from "lucide-react-native";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { GestureDetector, GestureHandlerRootView, usePanGesture } from "react-native-gesture-handler";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/theme/ThemeProvider";
import { Icon, T } from "./primitives";
import { cn } from "./cn";

/**
 * A bottom sheet: what a phone shows where the web shows a menu or a dialog.
 *
 * Slides up over a dimmed backdrop; a tap on the backdrop, a swipe down on the
 * sheet, or Back closes it. Sized to its content.
 *
 * `bare` gives the content the sheet's whole face, top edge included, with
 * the grabber floating over it — for a sheet that opens on a picture.
 */
export function Sheet({
  open,
  onClose,
  title,
  bare,
  children,
}: {
  open: boolean;
  onClose(): void;
  title?: string;
  bare?: boolean;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  // Kept mounted while the closing animation plays.
  const [wasOpen, setWasOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setClosing(true);
  }
  const visible = open || closing;
  const [height, setHeight] = useState(600);
  const offset = useSharedValue(height);
  const dim = useSharedValue(0);

  useEffect(() => {
    const ease = { duration: 220, easing: Easing.out(Easing.cubic) };
    if (open) {
      offset.set(height);
      offset.set(withTiming(0, ease));
      dim.set(withTiming(1, ease));
    } else if (visible) {
      dim.set(withTiming(0, { duration: 180 }));
      offset.set(
        withTiming(height, { duration: 180 }, (done) => {
          if (done) scheduleOnRN(setClosing, false);
        }),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const drag = usePanGesture({
    activeOffsetY: [-8, 8],
    onUpdate: (e) => {
      "worklet";
      offset.set(Math.max(0, e.translationY));
    },
    onDeactivate: (e) => {
      "worklet";
      if (e.translationY > 80 || e.velocityY > 800) scheduleOnRN(onClose);
      else offset.set(withTiming(0, { duration: 160 }));
    },
  });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));
  // The web's sheet overlay: black at half.
  const backdropStyle = useAnimatedStyle(() => ({ opacity: dim.value * 0.5 }));

  if (!visible) return null;
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      {/* A Modal is its own window; gestures inside need their own root. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: "#000" }, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
        </Animated.View>
        <GestureDetector gesture={drag}>
          <Animated.View
            onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
            style={[
              styles.sheet,
              { backgroundColor: colors.background, borderColor: colors.border, paddingBottom: insets.bottom + 16 },
              bare && styles.bare,
              sheetStyle,
            ]}
            accessibilityViewIsModal
          >
            {/* The grabber, as on the web's call sheet: the way out as well as the sign of one. */}
            <View style={[styles.handle, bare && styles.floating, { backgroundColor: bare ? "#fff" : colors["muted-foreground"] }]} />
            {title && !bare ? <T className="px-4 pb-1 text-sm font-semibold">{title}</T> : null}
            {children}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    // rounded-t-2xl and a top border, as the web's bottom sheets.
    borderTopLeftRadius: 23.4,
    borderTopRightRadius: 23.4,
    borderTopWidth: 1,
    paddingTop: 13,
  },
  handle: { alignSelf: "center", width: 44, height: 4.4, borderRadius: 2.2, opacity: 0.4, marginBottom: 13 },
  bare: { paddingTop: 0, overflow: "hidden" },
  // Over a banner, whatever its colours: white, a little stronger.
  floating: { position: "absolute", top: 8, zIndex: 1, opacity: 0.7 },
});

/** A choice in a sheet — the web's sheet rows: an icon, then what it does. */
export function SheetRow({
  icon,
  label,
  onPress,
  destructive,
}: {
  icon: ComponentType<LucideProps>;
  label: string;
  onPress(): void;
  destructive?: boolean;
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" className="flex-row items-center gap-3 px-4 py-3 active:bg-accent">
      <Icon as={icon} size={17} tone={destructive ? "destructive" : "foreground"} />
      <T className={cn("text-sm", destructive ? "text-destructive" : "text-foreground")}>{label}</T>
    </Pressable>
  );
}
