import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Mic, Square } from "lucide-react-native";
import type { MicTest } from "@chatter/core/voice/media";
import { getVoiceSettings, micGain, subscribeVoiceSettings, updateVoiceSettings } from "@chatter/core/voice/settings";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { createNativeVoiceBackend } from "@/voice/nativeBackend";
import { showToast } from "@/platform/toast";
import { Button, Segmented } from "@/ui/controls";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { Slider } from "@/ui/Slider";
import { T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { UI_HINT } from "@/ui/roles";
import { SettingsSection } from "@/ui/settings";

/**
 * Voice — the web's Voice Settings, as much of it as a phone has. The same
 * shared settings (core/voice/settings), so a change reaches a call that is
 * already running. The microphone, its echo cancellation and noise
 * suppression are Android's own and always on in a call, and the speaker or
 * headset is chosen from the call bar, so neither has a setting here.
 */
export default function VoiceSettings() {
  const insets = useSafeAreaInsets();
  const state = useChatter();
  const { voice } = useChatterActions();
  const settings = useSyncExternalStore(subscribeVoiceSettings, getVoiceSettings);
  const [level, setLevel] = useState(0);
  const [testing, setTesting] = useState(false);
  const test = useRef<MicTest | null>(null);

  const stopTest = () => {
    test.current?.stop();
    test.current = null;
    setTesting(false);
    setLevel(0);
  };

  // A test never outlives the screen.
  useEffect(() => () => test.current?.stop(), []);

  const startTest = async () => {
    stopTest();
    try {
      test.current = await createNativeVoiceBackend().startMicTest(
        {
          deviceId: settings.inputDeviceId,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppressionMode,
          autoGainControl: settings.autoGainControl,
          gain: micGain(settings),
          outputDeviceId: settings.outputDeviceId,
        },
        setLevel,
      );
      setTesting(true);
    } catch (e) {
      showToast({ tone: "error", message: "The microphone is not available", description: e instanceof Error ? e.message : undefined });
    }
  };

  // A call already holds the microphone.
  const inCall = state.inVoiceChannel;

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <ScreenHeader title="Voice" />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} contentContainerClassName="gap-4 p-4">
        <SettingsSection
          title="Input mode"
          hint={
            settings.inputMode === "ptt"
              ? "Your microphone is open only while you hold the talk button in the call bar."
              : "Your microphone is open whenever you are unmuted, and lights up when you speak."
          }
        >
          <Segmented
            value={settings.inputMode}
            options={[
              { value: "open", label: "Voice activity" },
              { value: "ptt", label: "Push to talk" },
            ]}
            // In a call the engine switches the microphone over too; out of
            // one, the next call reads the setting.
            onChange={(inputMode) => (state.inVoiceChannel ? inputMode !== state.voiceInputMode && voice.toggleInputMode() : updateVoiceSettings({ inputMode }))}
          />
        </SettingsSection>

        <SettingsSection title="Output volume" hint="Everyone in a call, together. Each person has their own volume in the call's member list.">
          <View className="flex-row items-center gap-3">
            <View className="flex-1">
              <Slider
                value={settings.outputVolume}
                min={0}
                max={100}
                step={1}
                accessibilityLabel="Output volume"
                onChange={(outputVolume) => updateVoiceSettings({ outputVolume })}
              />
            </View>
            <T className="w-10 text-right text-xs text-muted-foreground">{settings.outputVolume}%</T>
          </View>
        </SettingsSection>

        <SettingsSection title="Mic test" hint={inCall ? "Not while you are in a call — it is using the microphone." : "Speak and watch the meter: it is the level the others would hear."}>
          <View className="h-2.5 overflow-hidden rounded-full bg-muted">
            <View className={cn("h-full rounded-full", level > 0.5 ? "bg-warning" : "bg-success")} style={{ width: `${Math.min(100, Math.round(level * 140))}%` }} />
          </View>
          <Button
            variant={testing ? "secondary" : "outline"}
            icon={testing ? Square : Mic}
            className="self-start"
            disabled={inCall && !testing}
            onPress={() => (testing ? stopTest() : void startTest())}
          >
            {testing ? "Stop test" : "Test microphone"}
          </Button>
        </SettingsSection>

        <T className={UI_HINT}>Echo cancellation, noise suppression and gain control are the phone's own, and always on in a call.</T>
      </ScrollView>
    </View>
  );
}
