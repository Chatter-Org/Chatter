import { useEffect, useState } from "react";
import { View } from "react-native";
import { GestureDetector, usePanGesture, useSimultaneousGestures, useTapGesture } from "react-native-gesture-handler";
import Animated, { FadeInUp, FadeOutUp, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { MessageSquare } from "lucide-react-native";
import { dismissBanner, subscribeBanner, type Banner } from "@/platform/banner";
import { serverImage } from "@/ui/media";
import { Icon, T } from "@/ui/primitives";
import { READING_WIDTH } from "@/ui/windowLayout";

/**
 * Draws the notification banner (platform/banner.ts) across the top of the
 * app: who and where, and the message. Tap it to go there; push it up to put
 * it away; left alone, it goes by itself.
 */
export function BannerHost() {
  const insets = useSafeAreaInsets();
  const [banner, setBanner] = useState<Banner | null>(null);
  useEffect(() => subscribeBanner(setBanner), []);

  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", top: insets.top + 8, left: 12, right: 12, alignItems: "center" }}
    >
      {banner ? <BannerCard key={`${banner.key}|${banner.body}`} banner={banner} /> : null}
    </View>
  );
}

function BannerCard({ banner }: { banner: Banner }) {
  const lift = useSharedValue(0);
  const open = () => {
    dismissBanner();
    banner.onPress?.();
  };

  const pan = usePanGesture({
    activeOffsetY: [-8, 8],
    onUpdate: (e) => {
      "worklet";
      // Upward only; a pull down gives a little and springs back.
      lift.set(e.translationY < 0 ? e.translationY : e.translationY / 4);
    },
    onDeactivate: (e) => {
      "worklet";
      if (e.translationY < -30 || e.velocityY < -500) scheduleOnRN(dismissBanner);
      else lift.set(withTiming(0));
    },
  });
  const tap = useTapGesture({
    onActivate: () => {
      "worklet";
      scheduleOnRN(open);
    },
  });
  const gesture = useSimultaneousGestures(pan, tap);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: lift.value }] }));
  const icon = serverImage(banner.icon);

  return (
    <Animated.View entering={FadeInUp} exiting={FadeOutUp} style={{ width: "100%", maxWidth: READING_WIDTH }}>
      <GestureDetector gesture={gesture}>
        <Animated.View
          style={style}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`${banner.title}: ${banner.body}`}
          accessibilityHint="Opens the conversation"
          className="flex-row items-center gap-3 rounded-lg border border-border bg-popover px-3 py-2.5 shadow-lg"
        >
          {icon ? (
            <Image source={icon} style={{ width: 36, height: 36, borderRadius: 8 }} contentFit="cover" />
          ) : (
            <View className="size-9 items-center justify-center rounded-lg bg-secondary">
              <Icon as={MessageSquare} size={18} />
            </View>
          )}
          <View className="min-w-0 flex-1">
            <T className="text-sm font-semibold" numberOfLines={1}>
              {banner.title}
            </T>
            <T className="text-sm text-muted-foreground" numberOfLines={2}>
              {banner.body}
            </T>
          </View>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}
