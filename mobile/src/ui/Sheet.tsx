import { useEffect, useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { GestureDetector, GestureHandlerRootView, usePanGesture } from "react-native-gesture-handler";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/theme/ThemeProvider";

/**
 * A bottom sheet: what a phone shows where the web shows a menu or a dialog.
 *
 * Slides up over a dimmed backdrop; a tap on the backdrop, a swipe down on the
 * sheet, or Back closes it. Sized to its content.
 */
export function Sheet({ open, onClose, children }: { open: boolean; onClose(): void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  // Kept mounted while the closing animation plays.
  const [visible, setVisible] = useState(open);
  const [height, setHeight] = useState(600);
  const offset = useSharedValue(height);
  const dim = useSharedValue(0);

  useEffect(() => {
    const ease = { duration: 220, easing: Easing.out(Easing.cubic) };
    if (open) {
      setVisible(true);
      offset.value = height;
      offset.value = withTiming(0, ease);
      dim.value = withTiming(1, ease);
    } else if (visible) {
      dim.value = withTiming(0, { duration: 180 });
      offset.value = withTiming(height, { duration: 180 }, (done) => {
        if (done) scheduleOnRN(setVisible, false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const drag = usePanGesture({
    activeOffsetY: [-8, 8],
    onUpdate: (e) => {
      "worklet";
      offset.value = Math.max(0, e.translationY);
    },
    onDeactivate: (e) => {
      "worklet";
      if (e.translationY > 80 || e.velocityY > 800) scheduleOnRN(onClose);
      else offset.value = withTiming(0, { duration: 160 });
    },
  });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: dim.value * 0.45 }));

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
              { backgroundColor: colors.popover, borderColor: colors.border, paddingBottom: insets.bottom + 12 },
              sheetStyle,
            ]}
            accessibilityViewIsModal
          >
            <View style={[styles.handle, { backgroundColor: colors["muted-foreground"] }]} />
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
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  handle: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, opacity: 0.5, marginBottom: 12 },
});
