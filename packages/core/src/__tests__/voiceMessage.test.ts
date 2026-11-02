/**
 * Voice messages are recognised by name alone, so the cases that matter are
 * an ordinary audio attachment that must not be taken for one, and the
 * recording extensions that must not be drawn as videos.
 */
import { describe, it, expect } from "vitest";
import {
  formatVoiceTime,
  isVoiceMessageUrl,
  voiceRecordingFormat,
  waveformPeaks,
} from "../voiceMessage";
import { isAudioUrl, isVideoUrl } from "../mediaTypes";

describe("isVoiceMessageUrl", () => {
  it("matches each recording format", () => {
    for (const ext of ["weba", "oga", "m4a"]) {
      expect(isVoiceMessageUrl(`https://chat.example/external/abc123/voice-message.${ext}`)).toBe(true);
    }
  });

  it("does not match other audio", () => {
    expect(isVoiceMessageUrl("https://chat.example/external/abc/song.m4a")).toBe(false);
    expect(isVoiceMessageUrl("https://chat.example/external/abc/my-voice-message.m4a")).toBe(false);
    expect(isVoiceMessageUrl("https://chat.example/external/abc/voice-message.mp3")).toBe(false);
  });

  it("is audio, not video", () => {
    for (const ext of ["weba", "oga", "m4a"]) {
      const url = `/external/abc/voice-message.${ext}`;
      expect(isAudioUrl(url)).toBe(true);
      expect(isVideoUrl(url)).toBe(false);
    }
  });
});

describe("voiceRecordingFormat", () => {
  it("prefers WebM Opus", () => {
    expect(voiceRecordingFormat(() => true)).toEqual({ mimeType: "audio/webm;codecs=opus", extension: "weba" });
  });

  it("falls back to Ogg, then MP4", () => {
    expect(voiceRecordingFormat((m) => m.startsWith("audio/ogg"))?.extension).toBe("oga");
    expect(voiceRecordingFormat((m) => m === "audio/mp4")?.extension).toBe("m4a");
  });

  it("is null when nothing records", () => {
    expect(voiceRecordingFormat(() => false)).toBeNull();
  });
});

describe("waveformPeaks", () => {
  it("scales the loudest bar to full height", () => {
    const peaks = waveformPeaks([0, 0.1, 0, -0.5, 0.2, 0.25], 3);
    expect(peaks).toHaveLength(3);
    expect(peaks[1]).toBe(1);
    expect(peaks[0]).toBeLessThan(peaks[2]);
  });

  it("draws silence as a floor, not nothing", () => {
    const peaks = waveformPeaks(new Float32Array(100), 10);
    expect(peaks.every((p) => p > 0 && p < 0.1)).toBe(true);
  });

  it("copes with fewer samples than bars", () => {
    expect(waveformPeaks([0.5], 4)).toHaveLength(4);
    expect(waveformPeaks([], 4)).toHaveLength(4);
  });
});

describe("formatVoiceTime", () => {
  it("formats minutes and seconds", () => {
    expect(formatVoiceTime(0)).toBe("0:00");
    expect(formatVoiceTime(65.9)).toBe("1:05");
    expect(formatVoiceTime(Infinity)).toBe("0:00");
  });
});
