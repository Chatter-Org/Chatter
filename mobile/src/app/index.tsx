import { useEffect, useEffectEvent, useRef, useState } from "react";
import { View } from "react-native";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { PanelLayout, usePanels } from "@/components/PanelLayout";
import { NavPanel, type RailSelection } from "@/components/NavPanel";
import { MembersPanel } from "@/components/MembersPanel";
import { ChatHeader } from "@/components/ChatHeader";
import { StreamOptInBar } from "@/components/StreamOptInBar";
import { ChatView } from "@/components/ChatView";
import { ThreadView } from "./thread";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ForumView, openForumPost } from "@/components/forum/ForumView";
import { router } from "expo-router";
import type { NotificationTarget } from "@chatter/core/notifications";
import { on } from "@/platform/events";
import { askToNotify, listenForOpenedNotifications } from "@/platform/notifications";
import { listenForShares, useIncomingShare } from "@/platform/shareIn";

/** The signed-in shell: panels around the open conversation. */
export default function Home() {
  const state = useChatter();
  const { selectRoom } = useChatterActions();
  const [rail, setRail] = useState<RailSelection>({ kind: "dms" });
  const landed = useRef(false);

  // Rooms arrive after sign-in. Land once — on the first server — so the app
  // never opens on an empty screen; after that, the reader is in charge.
  useEffect(() => {
    if (landed.current || state.currentRoomId || state.joinedRoomIds.length === 0) return;
    const first = state.joinedRoomIds.find((id) => !state.roomInfoMap[id]?.is_direct) ?? state.joinedRoomIds[0];
    if (!first) return;
    landed.current = true;
    // The rail follows (below): selectRoom makes it the room on screen at once.
    void selectRoom(first).catch(() => {
      landed.current = false;
    });
  }, [state.currentRoomId, state.joinedRoomIds, state.roomInfoMap, selectRoom]);

  // The rail follows the room on screen when something else changes it — a
  // notification, a link — settled in the same render that brings the room.
  const [followed, setFollowed] = useState<{ id: string | null; rooms: typeof state.roomInfoMap | null }>({
    id: null,
    rooms: null,
  });
  if (followed.id !== state.currentRoomId || followed.rooms !== state.roomInfoMap) {
    setFollowed({ id: state.currentRoomId, rooms: state.roomInfoMap });
    const id = state.currentRoomId;
    if (id) {
      const isDm = state.roomInfoMap[id]?.is_direct;
      setRail((r) => (isDm ? (r.kind === "dms" ? r : { kind: "dms" }) : r.kind === "server" && r.roomId === id ? r : { kind: "server", roomId: id }));
    }
  }

  return (
    <PanelLayout left={<NavPanel rail={rail} onRail={setRail} />} right={<MembersPanel />} thread={<ThreadPane />}>
      <Conversation />
      <NotificationNavigator onNavigate={() => (landed.current = true)} />
      <ShareReceiver />
    </PanelLayout>
  );
}

function Conversation() {
  const { leftDocked } = usePanels();
  const state = useChatter();
  // A forum channel, or a room that is a forum itself, has posts rather than
  // a timeline.
  const channel = state.channels.find((c) => c.channel_id === state.currentChannelId);
  const room = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : undefined;
  const forum = channel?.channel_type === "forum" || (!channel && room?.room_type === "forum");
  return (
    <View className="flex-1 bg-background" style={leftDocked ? { borderLeftWidth: 0 } : undefined}>
      <ChatHeader />
      <StreamOptInBar />
      {forum ? <ForumView key={`${state.currentRoomId}|${channel?.channel_id ?? ""}`} /> : <ChatView />}
    </View>
  );
}

/** The thread beside the conversation (wide windows). */
function ThreadPane() {
  const { closeThread } = usePanels();
  const insets = useSafeAreaInsets();
  return <ThreadView onClose={closeThread} top={insets.top} />;
}

/**
 * Where an opened notification goes — the web's `notification-navigate`
 * handler (ChatLayout.tsx): its room and channel, then the thread, the forum
 * post or the events it was about. The banner raises the event in the app;
 * a tapped notification raises it from the shade, including one that started
 * the app, which waits for the conversations to load first.
 */
function NotificationNavigator({ onNavigate }: { onNavigate(): void }) {
  const state = useChatter();
  const { selectRoom, selectChannel, openThread } = useChatterActions();
  const panels = usePanels();
  const loaded = state.joinedRoomIds.length > 0;

  const go = useEffectEvent(async (target: NotificationTarget) => {
    if (!target?.roomId) return;
    // Settles the first landing too, so it cannot pull the reader elsewhere.
    onNavigate();
    // Back to the conversation from wherever the app was (settings, a profile).
    if (router.canDismiss()) router.dismissAll();
    panels.close();
    try {
      if (target.roomId !== state.currentRoomId) await selectRoom(target.roomId);
      if (target.channelId) await selectChannel(target.channelId);
      if (target.postId) {
        openForumPost(target.roomId, target.postId, target.channelId ?? null);
      } else if (target.threadId) {
        await openThread(target.threadId);
        if (panels.threadBeside) panels.openThread();
        else router.push("/thread");
      } else if (target.panel === "events") {
        router.push("/events");
      }
    } catch {
      // Gone since (left the room, deleted): staying put is the answer.
    }
  });

  useEffect(() => on<NotificationTarget>("notification-navigate", (t) => void go(t)), []);

  // Opened from the shade: once there is something to open.
  useEffect(() => {
    if (!loaded) return;
    return listenForOpenedNotifications();
  }, [loaded]);

  // Signed in is when notifying starts to mean something; ask once.
  useEffect(() => {
    void askToNotify();
  }, []);

  return null;
}

/**
 * Something shared from another app: once the conversations are in, the
 * screen that asks where it goes (/share).
 */
function ShareReceiver() {
  const loaded = useChatter().joinedRoomIds.length > 0;
  const share = useIncomingShare();
  useEffect(() => listenForShares(), []);
  useEffect(() => {
    if (!loaded || !share) return;
    if (router.canDismiss()) router.dismissAll();
    router.push("/share");
  }, [loaded, share]);
  return null;
}
