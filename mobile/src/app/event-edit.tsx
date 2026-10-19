import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { CalendarDays, Clock, ImagePlus, MapPin, Trash2, Volume2, X } from "lucide-react-native";
import { apiUploadFile } from "@chatter/core/api";
import { REMINDER_LEAD_MINUTES, nextHalfHour } from "@chatter/core/eventTime";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { fromImagePicker } from "@/components/AttachSheet";
import { nativeUploadSource, type PickedFile } from "@/platform/uploads";
import { showToast } from "@/platform/toast";
import { Button } from "@/ui/controls";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { serverImage } from "@/ui/media";
import { UI_HINT } from "@/ui/roles";
import { Field, TextField } from "@/ui/settings";

type Place = "channel" | "elsewhere";

const DEFAULT_LENGTH_MS = 60 * 60 * 1000;

/**
 * Scheduling an event, or editing one (`?id=`) — the web's EventDialog as a
 * screen. Dates and times are the phone's own pickers rather than the web's
 * datetime-local field; everything else is the dialog's.
 */
export default function EditEvent() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const state = useChatter();
  const { createEvent, updateEvent } = useChatterActions();
  const insets = useSafeAreaInsets();
  const event = id ? state.roomEvents.find((e) => e.event_id === id) : undefined;
  const voiceChannels = useMemo(() => state.channels.filter((c) => c.channel_type === "voice"), [state.channels]);

  const [initial] = useState(() => {
    if (event) {
      return {
        name: event.name,
        description: event.description,
        place: (event.channel_id ? "channel" : "elsewhere") as Place,
        channelId: event.channel_id,
        location: event.location,
        startsAt: event.starts_at,
        endsAt: event.ends_at,
        coverUrl: event.cover_url,
      };
    }
    const start = nextHalfHour();
    return {
      name: "",
      description: "",
      place: (voiceChannels.length > 0 ? "channel" : "elsewhere") as Place,
      channelId: voiceChannels[0]?.channel_id ?? "",
      location: "",
      startsAt: start,
      endsAt: start + DEFAULT_LENGTH_MS,
      coverUrl: "",
    };
  });
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [place, setPlace] = useState<Place>(initial.place);
  const [channelId, setChannelId] = useState(initial.channelId);
  const [location, setLocation] = useState(initial.location);
  const [startsAt, setStartsAt] = useState(initial.startsAt);
  // 0 is open-ended.
  const [endsAt, setEndsAt] = useState(initial.endsAt);
  const [coverUrl, setCoverUrl] = useState(initial.coverUrl);
  const [coverFile, setCoverFile] = useState<PickedFile | null>(null);
  const [saving, setSaving] = useState(false);

  const nameOk = name.trim().length > 0;
  const endOk = !endsAt || endsAt > startsAt;
  const canSave = nameOk && endOk && !saving;
  const cover = coverFile ? { uri: coverFile.uri } : serverImage(coverUrl);

  const pickCover = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [3, 1], quality: 0.9 });
      if (!result.canceled) setCoverFile(fromImagePicker(result.assets)[0]);
    } catch (e) {
      showToast({ tone: "error", message: "Couldn't open your photos", description: e instanceof Error ? e.message : undefined });
    }
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    let coverOut = coverUrl;
    if (coverFile) {
      try {
        coverOut = (await apiUploadFile(nativeUploadSource(coverFile))).url;
      } catch (err) {
        showToast({ tone: "error", message: err instanceof Error ? err.message : "Could not upload the image" });
        setSaving(false);
        return;
      }
    }
    const draft = {
      name: name.trim(),
      description: description.trim(),
      location: place === "elsewhere" ? location.trim() : "",
      channel_id: place === "channel" ? channelId : "",
      starts_at: startsAt,
      ends_at: endsAt,
      cover_url: coverOut,
    };
    try {
      if (event) {
        await updateEvent(event.event_id, draft);
        showToast({ message: "Event updated" });
      } else {
        await createEvent(draft);
        showToast({ message: "Event scheduled" });
      }
      router.back();
    } catch (err) {
      showToast({ tone: "error", message: err instanceof Error ? err.message : "Could not save the event" });
      setSaving(false);
    }
  };

  // Moving the start carries an end along with it, keeping the length.
  const moveStart = (next: number) => {
    if (endsAt) setEndsAt(next + (endsAt - startsAt));
    setStartsAt(next);
  };

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-1 border-b border-border px-2 py-1.5">
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          className="h-10 w-10 items-center justify-center rounded-lg active:bg-accent"
        >
          <Icon as={X} size={22} />
        </Pressable>
        <T className="flex-1 px-1 text-sm font-semibold">{event ? "Edit event" : "Schedule an event"}</T>
        <Button size="sm" disabled={!canSave} onPress={() => void save()}>
          {saving ? "Saving..." : event ? "Save changes" : "Schedule"}
        </Button>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 p-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <T className={UI_HINT}>
          Times are in your own timezone — everyone sees them in theirs. Anyone who says they are coming is reminded {REMINDER_LEAD_MINUTES} minutes
          before it starts.
        </T>

        {/* A slim strip while empty; the card's 3:1 once there is a picture. */}
        <Pressable
          onPress={() => void pickCover()}
          accessibilityRole="button"
          accessibilityLabel={cover ? "Replace the cover image" : "Add a cover image"}
          className={cn(
            "items-center justify-center overflow-hidden rounded-md border-2 border-dashed border-muted-foreground/30 active:border-muted-foreground/60",
            cover ? "" : "h-14 flex-row gap-1.5",
          )}
          style={cover ? { aspectRatio: 3 } : undefined}
        >
          {cover ? (
            <Image source={cover} style={{ width: "100%", height: "100%" }} contentFit="cover" />
          ) : (
            <>
              <Icon as={ImagePlus} size={16} />
              <T className="text-xs text-muted-foreground">Add a cover image</T>
            </>
          )}
        </Pressable>
        {cover ? (
          <Pressable
            onPress={() => {
              setCoverFile(null);
              setCoverUrl("");
            }}
            className="-mt-2 flex-row items-center gap-1 self-start"
          >
            <Icon as={Trash2} size={12} />
            <T className="text-xs text-muted-foreground">Remove cover</T>
          </Pressable>
        ) : null}

        <Field label="Name">
          <TextField value={name} onChangeText={setName} placeholder="Board game night" maxLength={120} autoFocus={!event} />
        </Field>

        <Field label="Starts">
          <DateTimeRow value={startsAt} onChange={moveStart} />
        </Field>

        <Field label="Ends (optional)">
          {endsAt ? (
            <View className="gap-1.5">
              <DateTimeRow value={endsAt} onChange={setEndsAt} />
              <Pressable onPress={() => setEndsAt(0)} className="self-start">
                <T className="text-xs text-muted-foreground underline">No end time</T>
              </Pressable>
            </View>
          ) : (
            <Button variant="outline" size="sm" className="self-start" onPress={() => setEndsAt(startsAt + DEFAULT_LENGTH_MS)}>
              Add an end time
            </Button>
          )}
          {!endOk ? <T className="text-xs text-destructive">An event cannot end before it starts.</T> : null}
        </Field>

        <Field label="Where">
          <View className="flex-row gap-1.5">
            <Button
              size="sm"
              icon={Volume2}
              variant={place === "channel" ? "secondary" : "outline"}
              className="flex-1"
              disabled={voiceChannels.length === 0}
              onPress={() => setPlace("channel")}
            >
              Voice channel
            </Button>
            <Button size="sm" icon={MapPin} variant={place === "elsewhere" ? "secondary" : "outline"} className="flex-1" onPress={() => setPlace("elsewhere")}>
              Somewhere else
            </Button>
          </View>
          {place === "channel" ? (
            <View className="overflow-hidden rounded-md border border-input">
              {voiceChannels.map((c, i) => (
                <Pressable
                  key={c.channel_id}
                  onPress={() => setChannelId(c.channel_id)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: channelId === c.channel_id }}
                  className={cn("flex-row items-center gap-2 px-3 py-2.5 active:bg-accent/50", i > 0 && "border-t border-input", channelId === c.channel_id && "bg-accent")}
                >
                  <Icon as={Volume2} size={14} />
                  <T className="flex-1 text-sm">{c.name}</T>
                </Pressable>
              ))}
            </View>
          ) : (
            <TextField value={location} onChangeText={setLocation} placeholder="A link, an address, or anything else" maxLength={200} />
          )}
        </Field>

        <Field label="Details (optional)">
          <TextField
            value={description}
            onChangeText={setDescription}
            placeholder="What is it, what to bring, anything people should know."
            maxLength={4000}
            multiline
          />
        </Field>
      </ScrollView>
    </View>
  );
}

/** A moment as two buttons, each opening the phone's own picker. */
function DateTimeRow({ value, onChange }: { value: number; onChange(next: number): void }) {
  const date = new Date(value);
  const open = (mode: "date" | "time") =>
    DateTimePickerAndroid.open({
      value: date,
      mode,
      is24Hour: false,
      onChange: (e, picked) => {
        if (e.type !== "set" || !picked) return;
        const next = new Date(value);
        if (mode === "date") next.setFullYear(picked.getFullYear(), picked.getMonth(), picked.getDate());
        else next.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
        onChange(next.getTime());
      },
    });
  return (
    <View className="flex-row gap-1.5">
      <Button variant="outline" icon={CalendarDays} className="flex-[3] justify-start" onPress={() => open("date")}>
        {date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
      </Button>
      <Button variant="outline" icon={Clock} className="flex-[2] justify-start" onPress={() => open("time")}>
        {date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </Button>
    </View>
  );
}
