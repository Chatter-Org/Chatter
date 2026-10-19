import { Pressable, View } from "react-native";
import { router } from "expo-router";
import { Monitor, Video } from "lucide-react-native";
import { displayUserId } from "@chatter/core/utils";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { Icon, T } from "@/ui/primitives";

/**
 * Someone in the call is streaming — the web's StreamOptInBar: who, and a way
 * in. Watching is a choice, so nothing is fetched until it is made; opening
 * the viewer is that choice.
 */
export function StreamOptInBar() {
  const state = useChatter();
  const { voice } = useChatterActions();
  if (!state.inVoiceChannel || state.screenViewerOpen) return null;

  const screens = state.activeScreenSharers.filter((id) => id !== state.userId);
  const cameras = state.activeWebcamStreamers.filter((id) => id !== state.userId);
  // Someone sharing a screen and a camera at once is one person, not two.
  const streamers = Array.from(new Set([...screens, ...cameras]));
  if (streamers.length === 0) return null;

  const name = (id: string) => state.userPresence[id]?.displayName || displayUserId(id);
  const label =
    streamers.length === 1
      ? `${name(streamers[0])} is streaming`
      : streamers.length === 2
        ? `${name(streamers[0])} and ${name(streamers[1])} are streaming`
        : `${streamers.length} people are streaming`;

  // A screen first, when there is one: it is usually what people came for.
  const open = () => {
    if (screens[0]) voice.watch(screens[0], "screen");
    else voice.watch(cameras[0], "webcam");
    router.push("/watch");
  };

  return (
    <View className="flex-row items-center gap-2 border-b border-border bg-info/10 px-3 py-1.5">
      <View className="size-2 rounded-full bg-destructive" />
      <Icon as={screens.length > 0 ? Monitor : Video} size={14} tone="info" />
      <T className="min-w-0 flex-1 text-sm text-muted-foreground" numberOfLines={1}>
        {label}
      </T>
      <Pressable
        onPress={open}
        accessibilityRole="button"
        className="h-9 flex-row items-center gap-1.5 rounded-md bg-primary px-3 active:bg-primary/90"
      >
        <Icon as={Monitor} size={14} tone="primary-foreground" />
        <T className="text-xs font-medium text-primary-foreground">View stream</T>
      </Pressable>
    </View>
  );
}
