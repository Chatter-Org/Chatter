import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { PanelLayout, usePanels } from "@/components/PanelLayout";
import { NavPanel, type RailSelection } from "@/components/NavPanel";
import { MembersPanel } from "@/components/MembersPanel";
import { ChatHeader } from "@/components/ChatHeader";
import { ChatView } from "@/components/ChatView";
import { ThreadView } from "./thread";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ForumView } from "@/components/forum/ForumView";

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
    setRail(state.roomInfoMap[first]?.is_direct ? { kind: "dms" } : { kind: "server", roomId: first });
    void selectRoom(first).catch(() => {
      landed.current = false;
    });
  }, [state.currentRoomId, state.joinedRoomIds, state.roomInfoMap, selectRoom]);

  // The rail follows the room on screen when something else changes it — a
  // notification, a link.
  useEffect(() => {
    const id = state.currentRoomId;
    if (!id) return;
    const isDm = state.roomInfoMap[id]?.is_direct;
    setRail((r) => (isDm ? (r.kind === "dms" ? r : { kind: "dms" }) : r.kind === "server" && r.roomId === id ? r : { kind: "server", roomId: id }));
  }, [state.currentRoomId, state.roomInfoMap]);

  return (
    <PanelLayout left={<NavPanel rail={rail} onRail={setRail} />} right={<MembersPanel />} thread={<ThreadPane />}>
      <Conversation />
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
