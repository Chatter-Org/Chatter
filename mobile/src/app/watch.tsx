import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, ScrollView, StatusBar, View, useWindowDimensions } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RTCView } from "react-native-webrtc";
import { HeadphoneOff, Headphones, Mic, MicOff, Monitor, PhoneOff, PictureInPicture2, SwitchCamera, Video, VideoOff, X, type LucideIcon } from "lucide-react-native";
import { displayUserId } from "@chatter/core/utils";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { useWatchedStream } from "@/voice/viewing";
import { useWindowLayout } from "@/ui/windowLayout";
import { pictureInPicture } from "../../modules/chatter-call";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";

type Source = { kind: "screen" | "webcam"; userId: string };

/**
 * Watching a screen share or a webcam — the web's ScreenShareViewer: the one
 * chosen fills the screen, and with more than one going, a strip of the rest
 * to switch to. Tap the picture to hide the controls; turn the phone for a
 * wide share. Leaving lets go of every stream: watching is only while here.
 */
export default function Watch() {
  const state = useChatter();
  const { voice } = useChatterActions();
  const insets = useSafeAreaInsets();
  const [chrome, setChrome] = useState(true);
  const { tabletop } = useWindowLayout();
  const [pipEvent, setPip] = useState(false);
  // Going into the small window, and out of it, resizes the window, which
  // renders this again: asked then, the answer holds whether or not the
  // change event made it across.
  useWindowDimensions();
  const pip = pipEvent || pictureInPicture.active();

  // Leaving the app while watching takes the stream along in a small window;
  // closing that window is putting the stream away.
  // Shaped like the picture being watched, once its size is known.
  const [videoSize, setVideoSize] = useState({ width: 16, height: 9 });
  useEffect(() => {
    pictureInPicture.auto(true, videoSize.width, videoSize.height);
  }, [videoSize]);
  useEffect(() => {
    const off = pictureInPicture.onChange((active) => {
      setPip(active);
      if (!active) {
        setTimeout(() => {
          if (AppState.currentState !== "active") router.back();
        }, 400);
      }
    });
    return () => {
      off();
      pictureInPicture.auto(false);
    };
  }, []);

  const feeds = useMemo<Source[]>(
    () => [
      ...state.activeScreenSharers.filter((id) => id !== state.userId).map((userId) => ({ kind: "screen" as const, userId })),
      // One's own camera is there too, as the call sees it.
      ...state.activeWebcamStreamers.map((userId) => ({ kind: "webcam" as const, userId })),
    ],
    [state.activeScreenSharers, state.activeWebcamStreamers, state.userId],
  );
  const chosen =
    feeds.find((f) =>
      state.selectedScreenSharer ? f.kind === "screen" && f.userId === state.selectedScreenSharer : f.kind === "webcam" && f.userId === state.selectedWebcamStreamer,
    ) ?? feeds[0];

  // Nothing left to watch, or out of the call: back to the conversation.
  const over = !state.inVoiceChannel || feeds.length === 0;
  useEffect(() => {
    if (over) router.back();
  }, [over]);
  // Being on this screen is watching: open the viewer here (on whoever was
  // chosen, or the first going), and however the screen is left, let go.
  const first = feeds[0];
  const firstKey = first ? `${first.kind}:${first.userId}` : "";
  const openRef = useRef(state.screenViewerOpen);
  useEffect(() => {
    openRef.current = state.screenViewerOpen;
  });
  useEffect(() => {
    if (!openRef.current && first) voice.watch(first.userId, first.kind);
    // Once, as the screen arrives; a later choice is the strip's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, firstKey === ""]);
  useEffect(() => () => voice.stopWatching(), [voice]);

  const nameOf = (id: string) => state.userPresence[id]?.displayName || displayUserId(id) || id;
  const choose = (f: Source) => voice.watch(f.userId, f.kind);

  // Who is on screen and what to do about it, and the other feeds to switch
  // to: laid over the picture, or (half open like a laptop) below the hinge.
  const headerRow = chosen ? (
    <>
      <Icon as={chosen.kind === "screen" ? Monitor : Video} size={16} color="#fff" />
      <View className="min-w-0 flex-1">
        <T className="text-sm font-semibold text-white" numberOfLines={1}>
          {nameOf(chosen.userId)}
        </T>
        <T className="text-3xs text-white/70">{chosen.kind === "screen" ? "Sharing their screen" : "Camera"}</T>
      </View>
      <View className="rounded bg-red-600 px-1.5 py-0.5">
        <T className="text-3xs font-bold text-white">LIVE</T>
      </View>
      {chosen.kind === "webcam" && chosen.userId === state.userId ? (
        <>
          <Pressable
            onPress={voice.flipCamera}
            accessibilityRole="button"
            accessibilityLabel="Switch camera"
            hitSlop={8}
            className="size-10 items-center justify-center rounded-full active:bg-white/10"
          >
            <Icon as={SwitchCamera} size={20} color="#fff" />
          </Pressable>
          <Pressable
            onPress={voice.stopCamera}
            accessibilityRole="button"
            accessibilityLabel="Turn off camera"
            hitSlop={8}
            className="size-10 items-center justify-center rounded-full active:bg-white/10"
          >
            <Icon as={VideoOff} size={20} color="#fff" />
          </Pressable>
        </>
      ) : null}
      {pictureInPicture.available ? (
        <Pressable
          onPress={() => pictureInPicture.enter(videoSize.width, videoSize.height)}
          accessibilityRole="button"
          accessibilityLabel="Keep watching in a small window"
          hitSlop={8}
          className="size-10 items-center justify-center rounded-full active:bg-white/10"
        >
          <Icon as={PictureInPicture2} size={20} color="#fff" />
        </Pressable>
      ) : null}
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Stop watching"
        hitSlop={8}
        className="size-10 items-center justify-center rounded-full active:bg-white/10"
      >
        <Icon as={X} size={22} color="#fff" />
      </Pressable>
    </>
  ) : null;
  const feedStrip =
    feeds.length > 1 ? (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 px-3 pt-2">
        {feeds.map((f) => {
          const on = f === chosen || (f.kind === chosen?.kind && f.userId === chosen?.userId);
          return (
            <Pressable
              key={`${f.kind}:${f.userId}`}
              onPress={() => choose(f)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${nameOf(f.userId)}, ${f.kind === "screen" ? "screen" : "camera"}`}
              className={cn("overflow-hidden rounded-md border-2", on ? "border-primary" : "border-transparent")}
              style={{ width: 144, height: 81 }}
            >
              <Feed feed={f} mirror={f.kind === "webcam" && f.userId === state.userId} />
              <View className="absolute bottom-0 left-0 right-0 flex-row items-center gap-1 bg-black/60 px-1.5 py-0.5">
                <Icon as={f.kind === "screen" ? Monitor : Video} size={11} color="#fff" />
                <T className="flex-1 text-3xs text-white" numberOfLines={1}>
                  {nameOf(f.userId)}
                </T>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    ) : null;

  // A foldable propped half open: the picture above the hinge, everything to
  // press below it, where a hand rests.
  if (tabletop && !pip) {
    return (
      <View className="flex-1 bg-black">
        <StatusBar hidden />
        <View style={{ height: tabletop.y }}>{chosen ? <Feed feed={chosen} fill mirror={chosen.kind === "webcam" && chosen.userId === state.userId} onSize={setVideoSize} /> : null}</View>
        <View style={{ height: tabletop.height }} />
        <View style={{ flex: 1, gap: 12, paddingTop: 12, paddingBottom: insets.bottom + 16, backgroundColor: "#0a0a0a" }}>
          <View className="flex-row items-center gap-2 px-3">{headerRow}</View>
          {feedStrip}
          <View style={{ marginTop: "auto", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 16 }}>
            <DeckButton icon={state.isMuted ? MicOff : Mic} label={state.isMuted ? "Unmute" : "Mute"} on={state.isMuted} onPress={voice.toggleMute} />
            <DeckButton icon={state.isDeafened ? HeadphoneOff : Headphones} label={state.isDeafened ? "Undeafen" : "Deafen"} on={state.isDeafened} onPress={voice.toggleDeafen} />
            <DeckButton icon={PhoneOff} label="Leave" hangup onPress={() => void voice.leave()} />
          </View>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-black">
      <StatusBar hidden={!chrome || pip} />
      <Pressable className="flex-1" onPress={() => setChrome((c) => !c)} accessibilityLabel={chrome ? "Hide controls" : "Show controls"}>
        {chosen ? <Feed feed={chosen} fill mirror={chosen.kind === "webcam" && chosen.userId === state.userId} onSize={setVideoSize} /> : null}
      </Pressable>

      {chrome && !pip && headerRow ? (
        <View className="absolute left-0 right-0 flex-row items-center gap-2 bg-black/60 px-3 py-2" style={{ top: 0, paddingTop: insets.top + 8 }}>
          {headerRow}
        </View>
      ) : null}

      {chrome && !pip && feedStrip ? (
        <View className="absolute left-0 right-0 bg-black/60" style={{ bottom: 0, paddingBottom: insets.bottom + 8 }}>
          {feedStrip}
        </View>
      ) : null}
    </View>
  );
}

/** A round call control for the tabletop deck. */
function DeckButton({ icon, label, on, hangup, onPress }: { icon: LucideIcon; label: string; on?: boolean; hangup?: boolean; onPress(): void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: 56,
        height: 56,
        borderRadius: 28,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hangup ? (pressed ? "#b91c1c" : "#dc2626") : on ? "#ffffff" : pressed ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.15)",
      })}
    >
      <Icon as={icon} size={22} color={on && !hangup ? "#000" : "#fff"} />
    </Pressable>
  );
}

/** One person's screen or camera, or a spinner until it arrives. */
function Feed({
  feed,
  fill,
  mirror,
  onSize,
}: {
  feed: Source;
  fill?: boolean;
  mirror?: boolean;
  onSize?(size: { width: number; height: number }): void;
}) {
  const url = useWatchedStream(feed.kind, feed.userId);
  if (!url) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator color="#fff" size={fill ? "large" : "small"} />
      </View>
    );
  }
  // One's own camera, mirrored as a camera app shows it; the call sees it the right way round.
  return (
    <RTCView
      streamURL={url}
      mirror={mirror}
      onDimensionsChange={onSize ? (e) => e.nativeEvent.width > 0 && e.nativeEvent.height > 0 && onSize({ width: e.nativeEvent.width, height: e.nativeEvent.height }) : undefined}
      objectFit={fill || feed.kind === "screen" ? "contain" : "cover"}
      style={{ flex: 1, backgroundColor: "#000" }}
    />
  );
}
