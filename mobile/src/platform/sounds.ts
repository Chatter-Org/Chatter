import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { EVENT_GAIN, MAX_SOUND_SECS, clampVolume, loadSoundSettings, resolveSound, takeDeferredArrivalSound, type SoundEvent, type SoundPack } from "@chatter/core/soundRules";
import { serverAsset } from "./server";

/**
 * Chatter's sound effects on the phone — the web's lib/sounds playback, on
 * expo-audio. What plays for which event, and the listener's on/off and
 * volume, are the shared core's (soundRules); this only plays the file.
 *
 * Mixed with whatever else is playing rather than taking the audio focus: a
 * mention blip must not pause someone's music or duck their own call.
 *
 * The web plays the leave sound as the join sound backwards; with no audio
 * graph to reverse it in, the phone plays the join sound for both.
 */

let modeSet = false;

function ensureMode() {
  if (modeSet) return;
  modeSet = true;
  void setAudioModeAsync({ interruptionMode: "mixWithOthers", playsInSilentMode: false }).catch(() => {
    modeSet = false;
  });
}

export function playSoundUrl(url: string, gain = 1): void {
  const uri = serverAsset(url);
  if (!uri) return;
  const settings = loadSoundSettings();
  if (!settings.enabled || settings.volume === 0) return;
  ensureMode();
  try {
    const player = createAudioPlayer({ uri });
    player.volume = clampVolume(settings.volume * gain);
    // Every player holds an Android media session, which would otherwise stay
    // active — and take the headset's play button — after a half-second
    // blip. Released when it finishes, or once no effect could still be
    // playing, whichever comes first (the finish is not always reported).
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      sub.remove();
      // remove() only forgets the player; release() frees it and its session.
      player.remove();
      player.release();
    };
    const sub = player.addListener("playbackStatusUpdate", (status) => {
      if (status.didJustFinish) release();
    });
    setTimeout(release, (MAX_SOUND_SECS + 1) * 1000);
    player.play();
  } catch {
    // A sound that will not play is not an error.
  }
}

export function playSound(event: SoundEvent, pack?: SoundPack): void {
  const url = resolveSound(event, pack) ?? resolveSound("voice-join", pack);
  if (url) playSoundUrl(url, EVENT_GAIN[event]);
}

export function playDeferredArrivalSound(): void {
  const sound = takeDeferredArrivalSound();
  if (sound) playSoundUrl(sound.url, sound.gain);
}
