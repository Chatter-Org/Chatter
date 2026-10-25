import { useEffect, useMemo, useReducer, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ActivityIndicator, Alert, Pressable, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GestureDetector, usePanGesture, usePinchGesture, useSimultaneousGestures, useTapGesture } from "react-native-gesture-handler";
import { Canvas, Circle, Group, Image, Picture, Skia, Text, createPicture, matchFont } from "@shopify/react-native-skia";
import { Directory, File, Paths } from "expo-file-system";
import { Camera, Circle as CircleIcon, Eraser, MessageSquare, Minus, PaintBucket, Pen, Square, Trash2, Undo2, type LucideProps } from "lucide-react-native";
import { apiGetWhiteboardStrokes, type WhiteboardStroke } from "@chatter/core/api";
import { enqueueOutgoing } from "@chatter/core/outgoingUploads";
import { displayUserId } from "@chatter/core/utils";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { on } from "@/platform/events";
import { nativeUploadSource } from "@/platform/uploads";
import { showToast } from "@/platform/toast";
import { Slider } from "@/ui/Slider";
import { Sheet } from "@/ui/Sheet";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { ChatView } from "../ChatView";
import { ColorPickerSheet } from "../ColorPickerSheet";
import { BOARD_SIZE, Board, drawStroke, type NewStroke, type Tool } from "./board";

/**
 * A whiteboard channel — the web's WhiteboardArea: one shared 2000×2000
 * board everyone in the room draws on live, each stroke saved as it lands.
 * One finger draws; two pinch to zoom and drag the board about. The
 * channel's conversation slides up under it.
 */

const TOOLS: { tool: Tool; icon: ComponentType<LucideProps>; label: string }[] = [
  { tool: "pen", icon: Pen, label: "Pen" },
  { tool: "eraser", icon: Eraser, label: "Eraser" },
  { tool: "line", icon: Minus, label: "Line" },
  { tool: "rect", icon: Square, label: "Rectangle" },
  { tool: "circle", icon: CircleIcon, label: "Ellipse" },
  { tool: "fill", icon: PaintBucket, label: "Fill" },
];
const PRESET_COLORS = ["#000000", "#ffffff", "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280"];
const CURSOR_FADE_MS = 3000;
const CURSOR_THROTTLE_MS = 50;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;

interface Cursor {
  x: number;
  y: number;
  at: number;
}

/** The board's whereabouts on screen: canvas point × scale + offset. */
interface View2D {
  scale: number;
  x: number;
  y: number;
}

export function WhiteboardView() {
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const [chatting, setChatting] = useState(false);
  return (
    <View className={cn("flex-1", wide && "flex-row")}>
      <View className="flex-1">
        {/* The bar sits on the screen's bottom edge unless the conversation is under it. */}
        <BoardArea chatting={chatting} onToggleChat={() => setChatting((c) => !c)} atBottom={wide || !chatting} />
      </View>
      {chatting ? (
        <View className={cn(wide ? "w-[380px] border-l border-border" : "flex-1 border-t border-border")}>
          <ChatView />
        </View>
      ) : null}
    </View>
  );
}

function BoardArea({ chatting, onToggleChat, atBottom }: { chatting: boolean; onToggleChat(): void; atBottom: boolean }) {
  const state = useChatter();
  const insets = useSafeAreaInsets();
  const actions = useChatterActions();
  const roomId = state.currentRoomId ?? "";
  const channelId = state.currentChannelId ?? "";
  const me = state.userId;
  const [board] = useState(() => new Board());
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [loading, setLoading] = useState(true);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#000000");
  const [width, setWidth] = useState(3);
  const [styling, setStyling] = useState(false);
  const [customColor, setCustomColor] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [drawing, setDrawing] = useState<NewStroke | null>(null);
  const [cursors, setCursors] = useState<Record<string, Cursor>>({});
  // The clock the cursors fade by, ticking while there are any.
  const [now, setNow] = useState(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View2D | null>(null);

  // The view is mounted for one channel (keyed by it), so these hold.
  const send = (frame: Record<string, unknown>) => actions.send({ ...frame, room_id: roomId, channel_id: channelId });

  // Strokes this phone sent that the server has not yet echoed with their
  // ids, oldest first. The web drops its own echoes, so its undo of a stroke
  // drawn in the same visit names an id the server never had; here the echo
  // hands the stroke its real id, and undo works.
  const unconfirmed = useRef<string[]>([]);

  // The board: loaded on opening and again after a reconnect, since strokes
  // drawn meanwhile were never seen; then kept live from the socket.
  useEffect(() => {
    if (!roomId || !channelId) return;
    let live = true;
    const load = () =>
      void apiGetWhiteboardStrokes(roomId, channelId)
        .then((data) => {
          if (!live) return;
          unconfirmed.current = [];
          board.replaceAll(data.strokes);
          setLoading(false);
          redraw();
        })
        .catch(() => live && setLoading(false));
    load();
    const here = (msg: { room_id: string; channel_id?: string }) => msg.room_id === roomId && msg.channel_id === channelId;
    const offs = [
      on<{ room_id: string; stroke: WhiteboardStroke }>("whiteboard_stroke", (msg) => {
        if (msg.room_id !== roomId || msg.stroke.channel_id !== channelId) return;
        if (msg.stroke.user_id === me && unconfirmed.current.length > 0) {
          const temp = unconfirmed.current.shift();
          const mine = board.strokes.find((s) => s.stroke_id === temp);
          if (mine) {
            mine.stroke_id = msg.stroke.stroke_id;
            mine.timestamp = msg.stroke.timestamp;
            return;
          }
        }
        board.add(msg.stroke);
        redraw();
      }),
      on<{
        room_id: string;
        channel_id: string;
        user_id: string;
        x: number;
        y: number;
      }>("whiteboard_cursor", (msg) => {
        if (!here(msg) || msg.user_id === me) return;
        setCursors((c) => ({
          ...c,
          [msg.user_id]: { x: msg.x, y: msg.y, at: Date.now() },
        }));
      }),
      on<{ room_id: string; channel_id: string }>("whiteboard_clear", (msg) => {
        if (!here(msg)) return;
        unconfirmed.current = [];
        board.replaceAll([]);
        redraw();
      }),
      on<{
        room_id: string;
        channel_id: string;
        user_id: string;
        stroke_id: string;
      }>("whiteboard_undo", (msg) => {
        if (!here(msg)) return;
        if (board.remove(msg.stroke_id)) redraw();
      }),
      on("socket_reopened", load),
    ];
    return () => {
      live = false;
      offs.forEach((off) => off());
    };
  }, [roomId, channelId, me, board]);

  // Cursors fade out after a few seconds without moving.
  useEffect(() => {
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setCursors((c) => {
        const kept = Object.entries(c).filter(([, v]) => t - v.at < CURSOR_FADE_MS);
        return kept.length === Object.keys(c).length ? c : Object.fromEntries(kept);
      });
    }, 500);
    return () => clearInterval(timer);
  }, []);

  // The whole board fits the area to begin with, centred.
  const fit = (w: number, h: number): View2D => {
    const scale = Math.min(w, h) / BOARD_SIZE;
    return {
      scale,
      x: (w - BOARD_SIZE * scale) / 2,
      y: (h - BOARD_SIZE * scale) / 2,
    };
  };
  const shown = view ?? (size.w > 0 ? fit(size.w, size.h) : { scale: 1, x: 0, y: 0 });
  const toBoard = (x: number, y: number): [number, number] => [(x - shown.x) / shown.scale, (y - shown.y) / shown.scale];

  const lastCursorAt = useRef(0);
  const commit = (stroke: NewStroke) => {
    const temp = `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    board.add({
      ...stroke,
      stroke_id: temp,
      user_id: me ?? "",
      timestamp: Date.now(),
    });
    if (send({ type: "whiteboard_stroke", ...stroke })) unconfirmed.current.push(temp);
    redraw();
  };

  // One finger: draw. Shapes run from where it went down to where it is.
  const draw = usePanGesture({
    runOnJS: true,
    maxPointers: 1,
    minDistance: 0,
    onActivate: (e) => {
      if (tool === "fill") return;
      setDrawing({
        tool,
        color,
        width,
        points: [toBoard(e.x, e.y)],
        fill: false,
      });
    },
    onUpdate: (e) => {
      const p = toBoard(e.x, e.y);
      setDrawing((d) =>
        d
          ? {
              ...d,
              points: d.tool === "pen" || d.tool === "eraser" ? [...d.points, p] : [d.points[0], p],
            }
          : d,
      );
      if (Date.now() - lastCursorAt.current > CURSOR_THROTTLE_MS) {
        lastCursorAt.current = Date.now();
        send({ type: "whiteboard_cursor", x: p[0], y: p[1] });
      }
    },
    onDeactivate: (e) => {
      // A second finger turned it into a pinch: nothing was meant.
      if (!e.canceled && drawing) commit(drawing);
      setDrawing(null);
    },
  });

  // Fill is a tap, which a pan never sees.
  const tap = useTapGesture({
    runOnJS: true,
    onActivate: (e) => {
      if (tool === "fill")
        commit({
          tool: "fill",
          color,
          width: 0,
          points: [toBoard(e.x, e.y)],
          fill: true,
        });
    },
  });

  // Two fingers: zoom about the point between them, and follow them about.
  const pinchStart = useRef<{ view: View2D; fx: number; fy: number } | null>(null);
  const pinch = usePinchGesture({
    runOnJS: true,
    onActivate: (e) => {
      pinchStart.current = { view: shown, fx: e.focalX, fy: e.focalY };
    },
    onUpdate: (e) => {
      const start = pinchStart.current;
      if (!start || size.w === 0) return;
      const base = fit(size.w, size.h).scale;
      const scale = Math.min(base * MAX_ZOOM, Math.max(base * MIN_ZOOM, start.view.scale * e.scale));
      const k = scale / start.view.scale;
      setView({
        scale,
        x: e.focalX - (start.fx - start.view.x) * k,
        y: e.focalY - (start.fy - start.view.y) * k,
      });
    },
  });
  const gestures = useSimultaneousGestures(draw, pinch, tap);

  const undo = () => {
    const mine = [...board.strokes].reverse().find((s) => s.user_id === me);
    if (!mine) return;
    board.remove(mine.stroke_id);
    unconfirmed.current = unconfirmed.current.filter((id) => id !== mine.stroke_id);
    send({ type: "whiteboard_undo", stroke_id: mine.stroke_id });
    redraw();
  };

  const clear = () =>
    Alert.alert("Clear the whiteboard?", "This removes everyone's drawing, for everyone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          board.replaceAll([]);
          unconfirmed.current = [];
          send({ type: "whiteboard_clear" });
          redraw();
        },
      },
    ]);

  // The board as a picture, into the conversation (the web's camera button).
  const capture = () => {
    if (!roomId) return;
    setCapturing(true);
    try {
      const dir = new Directory(Paths.cache, "whiteboard");
      if (!dir.exists) dir.create();
      const file = new File(dir, `whiteboard-${Date.now()}.png`);
      file.write(board.png());
      const channel = state.channels.find((c) => c.channel_id === channelId);
      enqueueOutgoing({
        target: { kind: "channel", roomId, channelId },
        label: channel ? `#${channel.name}` : "this conversation",
        body: "",
        files: [
          nativeUploadSource({
            uri: file.uri,
            name: file.name,
            type: "image/png",
          }),
        ],
      });
      if (!chatting) onToggleChat();
    } catch (e) {
      showToast({
        message: "Couldn't capture the board",
        description: e instanceof Error ? e.message : undefined,
        tone: "error",
      });
    } finally {
      setCapturing(false);
    }
  };

  const font = useMemo(() => matchFont({ fontFamily: "sans-serif", fontSize: 13, fontWeight: "bold" }), []);
  const preview = useMemo(
    () => (drawing ? createPicture((canvas) => drawStroke(canvas, drawing), Skia.XYWHRect(0, 0, BOARD_SIZE, BOARD_SIZE)) : null),
    [drawing],
  );
  const nameOf = (id: string) => state.roomMembers.find((m) => m.userId === id)?.displayName || displayUserId(id);
  const zoomed = view !== null && size.w > 0 && Math.abs(view.scale / fit(size.w, size.h).scale - 1) > 0.01;

  return (
    <View className="flex-1 bg-muted">
      {/* The board takes the gestures; the controls over it sit outside the
          detector, or a tap on Undo would also draw (fill) under it. */}
      <View className="flex-1">
        <GestureDetector gesture={gestures}>
          <View
            className="flex-1 overflow-hidden"
            onLayout={(e) =>
              setSize({
                w: e.nativeEvent.layout.width,
                h: e.nativeEvent.layout.height,
              })
            }
          >
            <Canvas style={{ flex: 1 }}>
              <Group transform={[{ translateX: shown.x }, { translateY: shown.y }, { scale: shown.scale }]}>
                <Image image={board.image} x={0} y={0} width={BOARD_SIZE} height={BOARD_SIZE} />
                {preview ? <Picture picture={preview} /> : null}
              </Group>
              {/* Others' cursors, at the web's size on screen whatever the zoom:
                drawn in board units, a name is unreadable on a phone. */}
              {!drawing
                ? Object.entries(cursors).map(([id, c]) => {
                    const x = c.x * shown.scale + shown.x;
                    const y = c.y * shown.scale + shown.y;
                    return (
                      <Group key={id} opacity={Math.min(1, Math.max(0, 1 - (now - c.at) / CURSOR_FADE_MS))}>
                        <Circle cx={x} cy={y} r={5} color="#3b82f6" />
                        <Circle cx={x} cy={y} r={5} color="#ffffff" style="stroke" strokeWidth={2} />
                        <Text x={x + 10} y={y - 10} text={nameOf(id)} font={font} color="#3b82f6" />
                      </Group>
                    );
                  })
                : null}
            </Canvas>
            {loading ? (
              <View className="absolute inset-0 items-center justify-center">
                <ActivityIndicator />
              </View>
            ) : null}
          </View>
        </GestureDetector>
        {/* What acts on the whole board, in a column at its corner. */}
        <View className="absolute right-2 top-2 overflow-hidden rounded-lg border border-border bg-card/95">
          <ToolButton label="Undo your last stroke" onPress={undo}>
            <Icon as={Undo2} size={19} />
          </ToolButton>
          <ToolButton label="Clear the board" onPress={clear}>
            <Icon as={Trash2} size={19} tone="destructive" />
          </ToolButton>
          <ToolButton label="Send the board to the conversation" onPress={capture}>
            {capturing ? <ActivityIndicator size="small" /> : <Icon as={Camera} size={19} />}
          </ToolButton>
          <ToolButton label={chatting ? "Hide the conversation" : "Show the conversation"} selected={chatting} onPress={onToggleChat}>
            <Icon as={MessageSquare} size={19} tone={chatting ? "foreground" : undefined} />
          </ToolButton>
        </View>
        {zoomed ? (
          <Pressable onPress={() => setView(null)} accessibilityRole="button" className="absolute left-2 top-2 rounded-full bg-card/90 px-3 py-1.5">
            <T className="text-xs">{Math.round((view!.scale / fit(size.w, size.h).scale) * 100)}% · Reset</T>
          </Pressable>
        ) : null}
      </View>

      {/* The web's tool column, as a row a thumb can reach. */}
      <View
        className="flex-row items-center justify-center gap-0.5 border-t border-border bg-card px-1.5 pt-1"
        style={{ paddingBottom: (atBottom ? insets.bottom : 0) + 4 }}
      >
        {TOOLS.map((t) => (
          <ToolButton key={t.tool} label={t.label} selected={tool === t.tool} onPress={() => setTool(t.tool)}>
            <Icon as={t.icon} size={19} tone={tool === t.tool ? "foreground" : undefined} />
          </ToolButton>
        ))}
        <ToolButton label="Colour and size" onPress={() => setStyling(true)}>
          <View className="h-6 w-6 items-center justify-center rounded-full border border-border" style={{ backgroundColor: color }}>
            <T
              className="text-[9px] font-bold"
              style={{
                color: color === "#ffffff" || color === "#eab308" ? "#000" : "#fff",
              }}
            >
              {width}
            </T>
          </View>
        </ToolButton>
      </View>

      <Sheet open={styling} onClose={() => setStyling(false)} title="Colour and size">
        <View className="gap-4 px-4 pb-4">
          <View className="flex-row flex-wrap gap-3">
            {PRESET_COLORS.map((c) => (
              <Pressable
                key={c}
                onPress={() => setColor(c)}
                accessibilityRole="button"
                accessibilityLabel={c}
                accessibilityState={{ selected: color === c }}
                className={cn("h-9 w-9 rounded-full border border-border", color === c && "border-2 border-primary")}
                style={{ backgroundColor: c }}
              />
            ))}
            <Pressable
              onPress={() => setCustomColor(true)}
              accessibilityRole="button"
              className="h-9 items-center justify-center rounded-full border border-border px-3"
            >
              <T className="text-xs">Custom</T>
            </Pressable>
          </View>
          <View className="gap-1">
            <View className="flex-row justify-between">
              <T className="text-xs font-medium">Size</T>
              <T className="text-xs text-muted-foreground">{width}px</T>
            </View>
            <Slider value={width} min={1} max={20} step={1} onChange={setWidth} accessibilityLabel="Stroke size" />
          </View>
        </View>
      </Sheet>
      <ColorPickerSheet open={customColor} title="Drawing colour" value={color} onClose={() => setCustomColor(false)} onPick={setColor} />
    </View>
  );
}

function ToolButton({ label, selected, onPress, children }: { label: string; selected?: boolean; onPress(): void; children: ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      className={cn("h-11 w-11 items-center justify-center rounded-md active:bg-accent", selected && "bg-accent")}
    >
      {children}
    </Pressable>
  );
}
