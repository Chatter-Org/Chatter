import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ArrowLeft,
  Bell,
  CalendarDays,
  CalendarPlus,
  Check,
  ChevronDown,
  Download,
  HelpCircle,
  MapPin,
  MoreVertical,
  Pencil,
  Trash2,
  Volume2,
  X,
} from "lucide-react-native";
import { apiListRsvps, type RoomEvent, type RsvpStatus } from "@chatter/core/api";
import { displayUserId } from "@chatter/core/utils";
import { can } from "@chatter/core/permissions";
import {
  REMINDER_LEAD_MINUTES,
  dayLabel,
  phaseOf,
  relativeLabel,
  timeRangeLabel,
  toIcs,
  type EventPhase,
} from "@chatter/core/eventTime";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { Avatar } from "@/components/Avatar";
import { showToast } from "@/platform/toast";
import { shareTextFile } from "@/platform/files";
import { Button } from "@/ui/controls";
import { Sheet, SheetRow } from "@/ui/Sheet";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { serverImage } from "@/ui/media";
import { UI_HEADING, UI_HINT } from "@/ui/roles";

/** The countdown is the point of the screen, so it moves on its own. */
const TICK_MS = 60_000;

const RSVP_CHOICES: { status: RsvpStatus; label: string }[] = [
  { status: "going", label: "Going" },
  { status: "maybe", label: "Maybe" },
  { status: "declined", label: "Can't make it" },
];

/**
 * The room's events — the web's EventsPanel, which at phone width already
 * covers the conversation, as a screen of its own: what is coming up under
 * the day it falls on, each with its answers, and the past folded away.
 */
export default function Events() {
  const state = useChatter();
  const { loadEvents } = useChatterActions();
  const insets = useSafeAreaInsets();
  const [showPast, setShowPast] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [menuFor, setMenuFor] = useState<RoomEvent | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  // The room switch loaded the list, but maybe a long while ago.
  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  const canCreate = can(state, "manage_events");
  const { upcoming, past, upcomingCount } = useMemo(() => {
    const up: RoomEvent[] = [];
    const done: RoomEvent[] = [];
    for (const event of state.roomEvents) (phaseOf(event, now) === "ended" ? done : up).push(event);
    up.sort((a, b) => a.starts_at - b.starts_at);
    done.sort((a, b) => b.starts_at - a.starts_at);
    return { upcoming: up, past: done, upcomingCount: up.filter((e) => !e.cancelled).length };
  }, [state.roomEvents, now]);

  const grouped = (events: RoomEvent[]) => {
    const out: ReactNode[] = [];
    let lastDay = "";
    for (const event of events) {
      const day = dayLabel(event.starts_at, now);
      if (day !== lastDay) {
        out.push(
          <T key={`day:${day}:${event.event_id}`} className={cn(UI_HEADING, "pt-1")}>
            {day}
          </T>,
        );
        lastDay = day;
      }
      out.push(<EventCard key={event.event_id} event={event} now={now} onMenu={() => setMenuFor(event)} />);
    }
    return out;
  };

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-1 border-b border-border px-2 py-1.5">
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back to chat"
          className="h-10 w-10 items-center justify-center rounded-lg active:bg-accent"
        >
          <Icon as={ArrowLeft} size={22} />
        </Pressable>
        <View className="min-w-0 flex-1 flex-row items-center gap-1.5 px-1">
          <T className="text-sm font-semibold">Events</T>
          {upcomingCount > 0 ? <T className="text-xs text-muted-foreground">({upcomingCount})</T> : null}
        </View>
        {canCreate ? (
          <Pressable
            onPress={() => router.push("/event-edit")}
            accessibilityRole="button"
            accessibilityLabel="Schedule an event"
            className="h-10 w-10 items-center justify-center rounded-lg active:bg-accent"
          >
            <Icon as={CalendarPlus} size={20} />
          </Pressable>
        ) : null}
      </View>

      <ScrollView contentContainerClassName="gap-2 p-3" contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
        {upcoming.length === 0 && past.length === 0 ? (
          <View className="items-center gap-2 px-4 py-10">
            <View className="opacity-40">
              <Icon as={CalendarDays} size={32} />
            </View>
            <T className="text-sm font-medium">Nothing scheduled</T>
            <T className={cn(UI_HINT, "text-center")}>
              {canCreate ? "Put something in the calendar and the room will see it here." : "When someone schedules something, it shows up here."}
            </T>
            {canCreate ? (
              <Button size="sm" variant="outline" icon={CalendarPlus} className="mt-1" onPress={() => router.push("/event-edit")}>
                Schedule an event
              </Button>
            ) : null}
          </View>
        ) : (
          <>
            {upcoming.length === 0 ? <T className={cn(UI_HINT, "py-4 text-center")}>Nothing coming up.</T> : grouped(upcoming)}
            {past.length > 0 ? (
              <View className="gap-2 pt-2">
                <Pressable
                  onPress={() => setShowPast((v) => !v)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showPast }}
                  className="flex-row items-center gap-1.5 py-1"
                >
                  <View style={showPast ? { transform: [{ rotate: "180deg" }] } : undefined}>
                    <Icon as={ChevronDown} size={14} />
                  </View>
                  <T className="text-xs text-muted-foreground">
                    {past.length} past event{past.length === 1 ? "" : "s"}
                  </T>
                </Pressable>
                {showPast ? grouped(past) : null}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      <EventMenu event={menuFor} now={now} onClose={() => setMenuFor(null)} />
    </View>
  );
}

function PhaseBadge({ phase }: { phase: EventPhase }) {
  if (phase === "live") {
    return (
      <View className="flex-row items-center gap-1 rounded-full bg-success/15 px-1.5 py-0.5">
        <View className="size-1.5 rounded-full bg-success" />
        <T className="text-3xs font-semibold uppercase tracking-wide text-success">Live</T>
      </View>
    );
  }
  if (phase === "soon") {
    return (
      <View className="rounded-full bg-warning/15 px-1.5 py-0.5">
        <T className="text-3xs font-semibold uppercase tracking-wide text-warning">Soon</T>
      </View>
    );
  }
  return null;
}

function EventCard({ event, now, onMenu }: { event: RoomEvent; now: number; onMenu(): void }) {
  const state = useChatter();
  const { setRsvp, selectChannel } = useChatterActions();
  const [expanded, setExpanded] = useState(false);
  const phase = phaseOf(event, now);
  const past = phase === "ended";
  const channel = state.channels.find((c) => c.channel_id === event.channel_id);
  const creator = state.userPresence[event.creator]?.displayName || displayUserId(event.creator);
  const cover = serverImage(event.cover_url);

  const answer = async (status: RsvpStatus) => {
    // Your own answer again withdraws it.
    const next = event.my_rsvp === status ? "" : status;
    try {
      await setRsvp(event.event_id, next);
    } catch (err) {
      showToast({ tone: "error", message: err instanceof Error ? err.message : "Could not save your answer" });
    }
  };

  return (
    <View
      className={cn(
        "overflow-hidden rounded-lg border",
        phase === "live" ? "border-success/40 bg-success/5" : "border-border",
        (past || event.cancelled) && "opacity-60",
      )}
    >
      {cover ? <Image source={cover} style={{ width: "100%", aspectRatio: 3 }} contentFit="cover" /> : null}
      <View className="px-3 py-2.5">
        <View className="flex-row items-start gap-2">
          <View className="min-w-0 flex-1">
            <View className="flex-row flex-wrap items-center gap-1.5">
              <PhaseBadge phase={event.cancelled ? "ended" : phase} />
              {event.cancelled ? (
                <View className="rounded-full bg-destructive/15 px-1.5 py-0.5">
                  <T className="text-3xs font-semibold uppercase tracking-wide text-destructive">Cancelled</T>
                </View>
              ) : null}
              <T className={cn("text-sm font-medium", event.cancelled && "line-through")}>{event.name}</T>
            </View>
            <T className={cn(UI_HINT, "mt-0.5")}>
              {timeRangeLabel(event)}
              {!event.cancelled ? ` · ${relativeLabel(event, now)}` : ""}
            </T>
            {channel || event.location ? (
              <View className="mt-1 flex-row items-center gap-1">
                <Icon as={channel ? Volume2 : MapPin} size={12} />
                {channel ? (
                  <Pressable
                    onPress={() => {
                      router.back();
                      void selectChannel(channel.channel_id);
                    }}
                    accessibilityRole="link"
                  >
                    <T className="text-xs text-muted-foreground underline" numberOfLines={1}>
                      {channel.name}
                    </T>
                  </Pressable>
                ) : (
                  <T className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>
                    {event.location}
                  </T>
                )}
              </View>
            ) : null}
          </View>
          <Pressable
            onPress={onMenu}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Options for ${event.name}`}
            className="rounded p-1 active:bg-accent"
          >
            <Icon as={MoreVertical} size={16} />
          </Pressable>
        </View>

        {/* A cancelled or finished event is a record, not an invitation. */}
        {!past && !event.cancelled ? (
          <View className="mt-2 flex-row gap-1">
            {RSVP_CHOICES.map(({ status, label }) => {
              const active = event.my_rsvp === status;
              return (
                <Button
                  key={status}
                  size="sm"
                  variant={active ? "secondary" : "outline"}
                  icon={active ? (status === "going" ? Check : status === "maybe" ? HelpCircle : X) : undefined}
                  iconTone={active && status === "going" ? "success" : undefined}
                  className={cn("flex-1 px-1", active && status === "going" && "border border-success/40")}
                  textClassName={cn("text-2xs", active && status === "going" && "text-success", active && status === "declined" && "text-muted-foreground")}
                  accessibilityState={{ selected: active }}
                  onPress={() => void answer(status)}
                >
                  {label}
                </Button>
              );
            })}
          </View>
        ) : null}

        {!past && !event.cancelled && (event.my_rsvp === "going" || event.my_rsvp === "maybe") ? (
          <View className="mt-1.5 flex-row items-center gap-1">
            <Icon as={Bell} size={12} />
            <T className={UI_HINT}>We'll remind you {REMINDER_LEAD_MINUTES} minutes before.</T>
          </View>
        ) : null}

        <Pressable
          onPress={() => setExpanded((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          className="mt-2 flex-row items-center gap-2"
        >
          <GoingPile userIds={event.going_preview} total={event.going_count} />
          {event.maybe_count > 0 ? <T className={UI_HINT}>· {event.maybe_count} maybe</T> : null}
          <View className="ml-auto" style={expanded ? { transform: [{ rotate: "180deg" }] } : undefined}>
            <Icon as={ChevronDown} size={14} />
          </View>
        </Pressable>

        {expanded ? (
          <View className="mt-1 border-t border-border pt-2">
            {event.description ? <T className="text-xs text-muted-foreground">{event.description}</T> : null}
            <T className={cn(UI_HINT, "mt-1")}>Scheduled by {creator}</T>
            {state.currentRoomId ? <GuestList roomId={state.currentRoomId} eventId={event.event_id} /> : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** The first few faces coming, and the rest as a count. */
function GoingPile({ userIds, total }: { userIds: string[]; total: number }) {
  const state = useChatter();
  if (total === 0) return <T className={UI_HINT}>Nobody yet</T>;
  return (
    <View className="min-w-0 flex-row items-center gap-1.5">
      <View className="flex-row">
        {userIds.slice(0, 5).map((id, i) => {
          const p = state.userPresence[id];
          return (
            <View key={id} style={{ marginLeft: i ? -6 : 0 }} className="rounded-full border-2 border-background">
              <Avatar userId={id} name={p?.displayName || displayUserId(id)} url={p?.avatarUrl} size={18} textClassName="text-3xs" />
            </View>
          );
        })}
      </View>
      <T className={UI_HINT}>{total} going</T>
    </View>
  );
}

/** Everyone's answers, fetched only when someone opens the card. */
function GuestList({ roomId, eventId }: { roomId: string; eventId: string }) {
  const state = useChatter();
  const [lists, setLists] = useState<{ going: string[]; maybe: string[]; declined: string[] } | null>(null);
  useEffect(() => {
    let live = true;
    apiListRsvps(roomId, eventId)
      .then((d) => live && setLists(d))
      .catch(() => live && setLists({ going: [], maybe: [], declined: [] }));
    return () => {
      live = false;
    };
  }, [roomId, eventId]);

  if (!lists) return <T className={cn(UI_HINT, "py-2")}>Loading…</T>;
  const sections: [string, string[]][] = [
    ["Going", lists.going],
    ["Maybe", lists.maybe],
    ["Can't make it", lists.declined],
  ];
  if (sections.every(([, ids]) => ids.length === 0)) return <T className={cn(UI_HINT, "py-2")}>Nobody has answered yet.</T>;
  return (
    <View className="gap-2 pt-1">
      {sections.map(([title, ids]) =>
        ids.length === 0 ? null : (
          <View key={title} className="gap-1">
            <T className={UI_HEADING}>
              {title} — {ids.length}
            </T>
            <View className="flex-row flex-wrap gap-1">
              {ids.map((id) => {
                const p = state.userPresence[id];
                const label = p?.displayName || displayUserId(id);
                return (
                  <View key={id} className="flex-row items-center gap-1.5 rounded-full bg-accent/60 py-0.5 pl-0.5 pr-2">
                    <Avatar userId={id} name={label} url={p?.avatarUrl} size={16} textClassName="text-3xs" />
                    <T className="text-xs" numberOfLines={1}>
                      {label}
                    </T>
                  </View>
                );
              })}
            </View>
          </View>
        ),
      )}
    </View>
  );
}

/** The card's "⋮": calendar, and for whoever can tend it, edit, cancel, delete. */
function EventMenu({ event, now, onClose }: { event: RoomEvent | null; now: number; onClose(): void }) {
  const state = useChatter();
  const { updateEvent, deleteEvent } = useChatterActions();
  const canEdit = !!event && (event.creator === state.userId || can(state, "manage_events"));
  const past = !!event && phaseOf(event, now) === "ended";
  const fail = (what: string) => (err: unknown) => showToast({ tone: "error", message: err instanceof Error ? err.message : what });

  return (
    <Sheet open={!!event} onClose={onClose} title={event?.name}>
      {event ? (
        <View style={styles.rows}>
          <SheetRow
            icon={Download}
            label="Add to calendar"
            onPress={() => {
              onClose();
              const file = `${event.name.replace(/[^\w\s-]/g, "").trim() || "event"}.ics`;
              void shareTextFile(file, toIcs(event), "text/calendar");
            }}
          />
          {canEdit ? (
            <>
              <SheetRow
                icon={Pencil}
                label="Edit"
                onPress={() => {
                  onClose();
                  router.push({ pathname: "/event-edit", params: { id: event.event_id } });
                }}
              />
              {!event.cancelled && !past ? (
                <SheetRow
                  icon={X}
                  label="Cancel event"
                  onPress={() => {
                    onClose();
                    Alert.alert(`Cancel "${event.name}"?`, "It stays in the list marked cancelled, so everyone who said they were coming finds out.", [
                      { text: "Keep it", style: "cancel" },
                      { text: "Cancel event", style: "destructive", onPress: () => void updateEvent(event.event_id, { cancelled: true }).catch(fail("Could not cancel the event")) },
                    ]);
                  }}
                />
              ) : null}
              <SheetRow
                icon={Trash2}
                label="Delete"
                destructive
                onPress={() => {
                  onClose();
                  Alert.alert(`Delete "${event.name}"?`, "This removes it and everyone's answers for good.", [
                    { text: "Cancel", style: "cancel" },
                    { text: "Delete", style: "destructive", onPress: () => void deleteEvent(event.event_id).catch(fail("Could not delete the event")) },
                  ]);
                }}
              />
            </>
          ) : null}
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({ rows: { paddingBottom: 4 } });
