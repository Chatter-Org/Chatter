import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Plus, X } from "lucide-react-native";
import { DURATION_CHOICES, MAX_OPTION_LEN, MAX_OPTIONS, MAX_QUESTION_LEN, MIN_OPTIONS } from "@chatter/core/polls";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { showToast } from "@/platform/toast";
import { Button, Switch } from "@/ui/controls";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { UI_HINT, UI_META } from "@/ui/roles";
import { Field, TextField } from "@/ui/settings";

/** An hour — answered the same afternoon (PollDialog). */
const DEFAULT_MINUTES = 60;

/**
 * Asking a poll — the web's PollDialog as a screen: the question, two answers
 * to start (the fewest a poll can have), how long it runs, and whether people
 * can pick several. It posts in the channel on screen.
 */
export default function NewPoll() {
  const state = useChatter();
  const { createPoll } = useChatterActions();
  const insets = useSafeAreaInsets();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [minutes, setMinutes] = useState(DEFAULT_MINUTES);
  const [multiSelect, setMultiSelect] = useState(false);
  const [saving, setSaving] = useState(false);

  const channel = state.channels.find((c) => c.channel_id === state.currentChannelId);
  const filled = options.map((o) => o.trim()).filter((o) => o.length > 0);
  const duplicated = new Set(filled.map((o) => o.toLowerCase())).size !== filled.length;
  const ready = question.trim().length > 0 && filled.length >= MIN_OPTIONS && !duplicated;

  const setOption = (index: number, value: string) => setOptions((prev) => prev.map((o, i) => (i === index ? value : o)));
  const addOption = () => setOptions((prev) => (prev.length >= MAX_OPTIONS ? prev : [...prev, ""]));
  const removeOption = (index: number) => setOptions((prev) => (prev.length <= MIN_OPTIONS ? prev : prev.filter((_, i) => i !== index)));

  const submit = async () => {
    if (!ready || saving) return;
    setSaving(true);
    try {
      await createPoll({ question: question.trim(), options: filled, duration_minutes: minutes, multi_select: multiSelect });
      router.back();
    } catch (err) {
      showToast({ tone: "error", message: err instanceof Error ? err.message : "Could not create the poll" });
      setSaving(false);
    }
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
        <View className="min-w-0 flex-1 px-1">
          <T className="text-sm font-semibold">Create a poll</T>
          {channel ? (
            <T className={UI_META} numberOfLines={1}>
              #{channel.name}
            </T>
          ) : null}
        </View>
        <Button size="sm" disabled={!ready || saving} onPress={() => void submit()}>
          {saving ? "Posting..." : "Create poll"}
        </Button>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 p-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <T className={UI_HINT}>It posts in this channel, and the results are posted back here when it ends.</T>

        <Field label="Question">
          <TextField value={question} onChangeText={setQuestion} placeholder="What should we play on Friday?" maxLength={MAX_QUESTION_LEN} autoFocus />
        </Field>

        <Field label="Answers">
          {options.map((option, index) => (
            <View key={index} className="flex-row items-center gap-1.5">
              <TextField
                className="flex-1"
                value={option}
                onChangeText={(v) => setOption(index, v)}
                placeholder={`Answer ${index + 1}`}
                maxLength={MAX_OPTION_LEN}
                returnKeyType={index === options.length - 1 && options.length < MAX_OPTIONS ? "next" : "done"}
                // Enter on the last answer adds the next, rather than posting
                // a half-written poll.
                onSubmitEditing={() => index === options.length - 1 && addOption()}
                submitBehavior={index === options.length - 1 && options.length < MAX_OPTIONS ? "submit" : "blurAndSubmit"}
              />
              <Button
                variant="ghost"
                size="icon"
                icon={X}
                disabled={options.length <= MIN_OPTIONS}
                accessibilityLabel="Remove this answer"
                onPress={() => removeOption(index)}
              />
            </View>
          ))}
          {options.length < MAX_OPTIONS ? (
            <Button variant="outline" size="sm" icon={Plus} onPress={addOption}>
              Add an answer
            </Button>
          ) : null}
          {duplicated ? <T className="text-xs text-destructive">Two answers are the same — the result could not say which one won.</T> : null}
        </Field>

        <Field label="Runs for">
          <View className="flex-row flex-wrap gap-1.5">
            {DURATION_CHOICES.map((choice) => (
              <Button
                key={choice.minutes}
                size="sm"
                variant={minutes === choice.minutes ? "secondary" : "outline"}
                className={cn(minutes === choice.minutes && "border border-primary/50")}
                accessibilityState={{ selected: minutes === choice.minutes }}
                onPress={() => setMinutes(choice.minutes)}
              >
                {choice.label}
              </Button>
            ))}
          </View>
        </Field>

        <View className="flex-row items-center justify-between gap-3">
          <View className="flex-1 gap-0.5">
            <T className="text-sm font-medium">Allow more than one answer</T>
            <T className="text-xs text-muted-foreground">Everyone can tick several. The bars stay a share of the people who voted, not of the votes.</T>
          </View>
          <Switch
            value={multiSelect}
            onValueChange={setMultiSelect}
            accessibilityLabel="Allow more than one answer"
          />
        </View>
      </ScrollView>
    </View>
  );
}
