import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Modal, Pressable, StatusBar, useWindowDimensions, View } from "react-native";
import {
  GestureDetector,
  GestureHandlerRootView,
  // The handler's own ScrollView, so paging and the picture's gestures share
  // the touch instead of the native scroll view taking it whole.
  ScrollView,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Share2, X } from "lucide-react-native";
import { serverImage } from "@/ui/media";
import { saveServerFile } from "@/platform/files";
import { T } from "@/ui/primitives";

const MAX_SCALE = 5;

/**
 * Pictures full screen: swipe between them, pinch or double-tap to zoom, drag
 * while zoomed, swipe down to put them away, share to save or send on.
 */
export function ImageViewer({ urls, index, onClose }: { urls: string[]; index: number | null; onClose(): void }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [page, setPage] = useState(index ?? 0);
  const [zoomed, setZoomed] = useState(false);
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);

  // Opening on a picture (or turning the phone) goes back to the one opened.
  const [openedAt, setOpenedAt] = useState({ index, width });
  if (openedAt.index !== index || openedAt.width !== width) {
    setOpenedAt({ index, width });
    if (index !== null) setPage(index);
  }
  useEffect(() => {
    if (index === null) return;
    // After the modal lays out, so the offset sticks.
    requestAnimationFrame(() => scroller.current?.scrollTo({ x: index * width, animated: false }));
  }, [index, width]);

  if (index === null) return null;
  const current = urls[page];

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <StatusBar barStyle="light-content" />
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: "#000" }}>
        <ScrollView
          ref={scroller}
          horizontal
          pagingEnabled
          scrollEnabled={!zoomed}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
        >
          {urls.map((url) => (
            <ZoomableImage key={url} url={url} width={width} height={height} onZoomChange={setZoomed} onDismiss={onClose} />
          ))}
        </ScrollView>
        <View className="absolute left-0 right-0 flex-row items-center justify-between px-2" style={{ top: insets.top + 4 }}>
          <Pressable onPress={onClose} accessibilityLabel="Close" className="h-11 w-11 items-center justify-center rounded-full bg-black/50">
            <X size={22} color="#fff" />
          </Pressable>
          {urls.length > 1 ? (
            <T className="text-sm text-white">
              {page + 1} / {urls.length}
            </T>
          ) : null}
          <Pressable
            onPress={() => current && void saveServerFile(current, current.split("/").pop() ?? "image")}
            accessibilityLabel="Share or save"
            className="h-11 w-11 items-center justify-center rounded-full bg-black/50"
          >
            <Share2 size={20} color="#fff" />
          </Pressable>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

function ZoomableImage({
  url,
  width,
  height,
  onZoomChange,
  onDismiss,
}: {
  url: string;
  width: number;
  height: number;
  onZoomChange(zoomed: boolean): void;
  onDismiss(): void;
}) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const dismissY = useSharedValue(0);

  const clampPan = () => {
    "worklet";
    const maxX = ((scale.value - 1) * width) / 2;
    const maxY = ((scale.value - 1) * height) / 2;
    tx.value = Math.min(maxX, Math.max(-maxX, tx.value));
    ty.value = Math.min(maxY, Math.max(-maxY, ty.value));
  };

  const pinch = usePinchGesture({
    onActivate: () => {
      "worklet";
      savedScale.value = scale.value;
    },
    onUpdate: (e) => {
      "worklet";
      scale.value = Math.min(MAX_SCALE, Math.max(1, savedScale.value * e.scale));
      clampPan();
    },
    onDeactivate: () => {
      "worklet";
      if (scale.value < 1.05) {
        scale.value = withTiming(1);
        tx.value = withTiming(0);
        ty.value = withTiming(0);
      }
      scheduleOnRN(onZoomChange, scale.value >= 1.05);
    },
  });

  const pan = usePanGesture({
    minPointers: 1,
    maxPointers: 2,
    onActivate: () => {
      "worklet";
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    },
    onUpdate: (e) => {
      "worklet";
      if (scale.value > 1.01) {
        tx.value = savedTx.value + e.translationX;
        ty.value = savedTy.value + e.translationY;
        clampPan();
      } else if (e.translationY > 0) {
        // Not zoomed: a downward drag puts the picture away.
        dismissY.value = e.translationY;
      }
    },
    onDeactivate: (e) => {
      "worklet";
      if (scale.value <= 1.01 && (dismissY.value > 120 || e.velocityY > 1000)) {
        scheduleOnRN(onDismiss);
      }
      dismissY.value = withTiming(0);
    },
  });

  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    onActivate: () => {
      "worklet";
      const zoomIn = scale.value < 1.5;
      scale.value = withTiming(zoomIn ? 2.5 : 1);
      tx.value = withTiming(0);
      ty.value = withTiming(0);
      scheduleOnRN(onZoomChange, zoomIn);
    },
  });

  // All three at once: a pan needs movement and a double tap needs none, so
  // they never claim the same touch; making the tap exclusive held every drag
  // back until the tap had timed out.
  const gesture = useSimultaneousGestures(pinch, pan, doubleTap);

  const style = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(0.6, dismissY.value / 400),
    transform: [{ translateX: tx.value }, { translateY: ty.value + dismissY.value }, { scale: scale.value }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[{ width, height, justifyContent: "center" }, style]}>
        <Image source={serverImage(url)} style={{ width, height }} contentFit="contain" recyclingKey={url} accessibilityLabel="Image" />
      </Animated.View>
    </GestureDetector>
  );
}
