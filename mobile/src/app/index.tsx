import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { PanelLayout, usePanels } from "@/components/PanelLayout";
import { NavPanel, type RailSelection } from "@/components/NavPanel";
import { MembersPanel } from "@/components/MembersPanel";
import { ChatHeader } from "@/components/ChatHeader";
import { ChatView } from "@/components/ChatView";

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
    <PanelLayout left={<NavPanel rail={rail} onRail={setRail} />} right={<MembersPanel />}>
      <Conversation />
    </PanelLayout>
  );
}

function Conversation() {
  const { leftDocked } = usePanels();
  return (
    <View className="flex-1 bg-background" style={leftDocked ? { borderLeftWidth: 0 } : undefined}>
      <ChatHeader />
      <ChatView />
    </View>
  );
}
