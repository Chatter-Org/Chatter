import { useEffect, useRef, useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GestureDetector, usePanGesture, useTapGesture, useSimultaneousGestures } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import { HeadphoneOff, MicOff } from "lucide-react-native";
import { displayUserId } from "@chatter/core/utils";
import { readProfileAccent } from "@chatter/core/profileTheme";
import { distanceGain, worldDistance } from "@chatter/core/voice/spatial";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { useSpeaking } from "@/voice/speaking";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/ui/controls";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Icon, T } from "@/ui/primitives";
import { UI_HINT } from "@/ui/roles";
import { useTheme } from "@/theme/ThemeProvider";

/** How often a drag may reach the socket (SpatialVoiceArea's MOVE_INTERVAL_MS). */
const MOVE_INTERVAL_MS = 60;
const AVATAR = 44;

type Point = { x: number; y: number };

/**
 * A spatial voice channel's floor — the web's SpatialVoiceArea: everyone in
 * the channel where they stand, faded with distance from you; tap or drag to
 * walk, which is what you hear by (the voice engine places each speaker from
 * the same positions). Positions are 0–1 across the floor; moves go out as
 * `voice_move`, metered with the last one always sent.
 */
export default function Floor() {
  const state = useChatter();
  const { voice } = useChatterActions();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const channelId = state.voiceChannelId;
  const channel = state.channels.find((c) => c.channel_id === channelId);
  const members = channelId ? (state.voiceChannelMembers[channelId] ?? []) : [];
  const inCall = state.inVoiceChannel && !!channelId && channel?.channel_type === "spatial";
  const speaking = useSpeaking(inCall, state.userId, voice.isSpeaking);

  // Out of the call, or in a call that has no floor: nothing to stand on.
  useEffect(() => {
    if (!inCall) router.back();
  }, [inCall]);

  const [size, setSize] = useState({ width: 0, height: 0 });
  // Where we have put ourselves; outlives the gesture, so a move does not snap
  // back to the old spot while its echo comes round.
  const [mine, setMine] = useState<Point | null>(null);
  const me = members.find((m) => m.userId === state.userId);
  const stored = me?.x !== undefined && me?.y !== undefined ? { x: me.x, y: me.y } : null;
  const myPoint = mine ?? stored ?? { x: 0.5, y: 0.5 };

  const lastSent = useRef(0);
  const pending = useRef<Point | null>(null);
  const flush = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flush.current) clearTimeout(flush.current);
    },
    [],
  );

  const sendMove = (p: Point) => voice.move(p.x, p.y);
  // A drag is a stream and only its end matters: drop frames in between, but
  // always send the last one, or the person stands where they are not.
  const queueMove = (p: Point) => {
    pending.current = p;
    const since = Date.now() - lastSent.current;
    if (since >= MOVE_INTERVAL_MS) {
      lastSent.current = Date.now();
      sendMove(p);
      pending.current = null;
      return;
    }
    if (flush.current) return;
    flush.current = setTimeout(() => {
      flush.current = null;
      if (!pending.current) return;
      lastSent.current = Date.now();
      sendMove(pending.current);
      pending.current = null;
    }, MOVE_INTERVAL_MS - since);
  };

  const walkTo = (px: number, py: number) => {
    if (!size.width || !size.height) return;
    const p = { x: Math.min(1, Math.max(0, px / size.width)), y: Math.min(1, Math.max(0, py / size.height)) };
    setMine(p);
    queueMove(p);
  };

  const pan = usePanGesture({
    minDistance: 0,
    onUpdate: (e) => {
      "worklet";
      scheduleOnRN(walkTo, e.x, e.y);
    },
  });
  const tap = useTapGesture({
    onActivate: (e) => {
      "worklet";
      scheduleOnRN(walkTo, e.x, e.y);
    },
  });
  const gesture = useSimultaneousGestures(pan, tap);

  const onLayout = (e: LayoutChangeEvent) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
  // The floor is 4:3 and as big as fits, by width or by height, whichever runs
  // out first (a landscape phone or an unfolded Fold runs out of height).
  const [area, setArea] = useState({ width: 0, height: 0 });
  const onArea = (e: LayoutChangeEvent) => setArea({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
  const HINT = 40;
  const fitWidth = Math.min(736, Math.max(0, area.width - 32), Math.max(0, (area.height - 32 - HINT) * (4 / 3)));
  const board = { width: fitWidth, height: (fitWidth * 3) / 4 };

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <ScreenHeader
        title={channel?.name ?? "Floor"}
        subtitle={members.length === 1 ? "1 person on the floor" : `${members.length} people on the floor`}
        right={
          <Button size="sm" variant="outline" className="mr-1" onPress={() => void voice.leave()}>
            Leave
          </Button>
        }
      />
      <View className="flex-1 items-center justify-center p-4" onLayout={onArea}>
        <GestureDetector gesture={gesture}>
          <View
            onLayout={onLayout}
            accessibilityLabel="The floor: tap or drag to walk"
            style={{ ...board, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.muted, overflow: "hidden" }}
          >
            {/* A grid, so a move reads as a move across something. */}
            {Array.from({ length: 7 }, (_, i) => (
              <View key={`v${i}`} pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: `${((i + 1) * 100) / 8}%`, width: 1, backgroundColor: colors.border, opacity: 0.5 }} />
            ))}
            {Array.from({ length: 7 }, (_, i) => (
              <View key={`h${i}`} pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: `${((i + 1) * 100) / 8}%`, height: 1, backgroundColor: colors.border, opacity: 0.5 }} />
            ))}

            {members.map((member) => {
              const isSelf = member.userId === state.userId;
              const at = isSelf ? myPoint : { x: member.x ?? 0.5, y: member.y ?? 0.5 };
              const presence = state.userPresence[member.userId];
              const name = presence?.displayName || displayUserId(member.userId);
              const accent = readProfileAccent(presence);
              const micOff = member.muted || member.deafened;
              const talking = speaking.has(member.userId) && !micOff;
              // Never quite gone: someone across the room is faint, not absent.
              const heard = isSelf ? 1 : distanceGain(worldDistance(myPoint, at));
              return (
                <View
                  key={member.userId}
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    left: at.x * size.width - 56,
                    top: at.y * size.height - AVATAR / 2,
                    width: 112,
                    alignItems: "center",
                    gap: 2,
                    opacity: 0.35 + 0.65 * heard,
                    zIndex: isSelf ? 2 : 1,
                  }}
                >
                  {isSelf ? (
                    // What you can hear, drawn where the falloff bites.
                    <View
                      style={{
                        position: "absolute",
                        width: 160,
                        height: 160,
                        borderRadius: 80,
                        top: AVATAR / 2 - 80,
                        backgroundColor: accent ?? colors.primary,
                        opacity: 0.12,
                      }}
                    />
                  ) : null}
                  <View style={{ borderRadius: 999, borderWidth: 3, borderColor: talking ? (accent ?? colors.success) : colors.background }}>
                    <Avatar userId={member.userId} name={name} url={presence?.avatarUrl} size={AVATAR - 6} />
                    {micOff ? (
                      <View style={{ position: "absolute", right: -2, bottom: -2, borderRadius: 999, padding: 2, backgroundColor: colors.background }}>
                        <Icon as={member.deafened ? HeadphoneOff : MicOff} size={12} tone="destructive" />
                      </View>
                    ) : null}
                  </View>
                  <View style={{ borderRadius: 4, paddingHorizontal: 6, backgroundColor: colors.background, opacity: 0.85 }}>
                    <T className="text-3xs" numberOfLines={1} style={accent ? { color: accent } : undefined}>
                      {name}
                      {isSelf ? " (you)" : ""}
                    </T>
                  </View>
                </View>
              );
            })}
          </View>
        </GestureDetector>
        <T className={UI_HINT} style={{ marginTop: 12, textAlign: "center" }}>
          Tap or drag anywhere on the floor to walk. People fade as you walk away.
        </T>
      </View>
    </View>
  );
}
