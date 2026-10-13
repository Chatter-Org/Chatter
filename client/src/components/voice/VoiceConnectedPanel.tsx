import {
  Mic, MicOff, Headphones, HeadphoneOff, Video, ScreenShare, PhoneOff, ChevronUp,
} from "lucide-react";
import type { ConnectionQuality } from "../VoiceControls";
import { canShareScreen } from "@/lib/webrtc";
import { ScreenFpsMenu } from "./ScreenFpsMenu";

interface VoiceConnectedPanelProps {
  publisherState: RTCPeerConnectionState;
  quality: ConnectionQuality;
  pingMs: number | null;
  roomName: string;
  channelName: string | null;
  isMuted: boolean;
  isDeafened: boolean;
  isWebcamActive?: boolean;
  isScreenSharing?: boolean;
  onToggleMute?: () => void;
  onToggleDeafen?: () => void;
  onToggleWebcam?: () => void;
  onToggleScreenShare?: () => void;
  onLeaveVoice?: () => void;
}

/** Four bars, lit up to the sampled quality, drawn in the call's status colour. */
function SignalBars({ quality }: { quality: ConnectionQuality }) {
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" fill="currentColor" aria-hidden>
      <rect x="0" y="10" width="3" height="4" rx="0.5" opacity={quality >= 1 ? 1 : 0.3} />
      <rect x="4.5" y="7" width="3" height="7" rx="0.5" opacity={quality >= 2 ? 1 : 0.3} />
      <rect x="9" y="3.5" width="3" height="10.5" rx="0.5" opacity={quality >= 3 ? 1 : 0.3} />
      <rect x="13" y="0" width="3" height="14" rx="0.5" opacity={quality >= 4 ? 1 : 0.3} />
    </svg>
  );
}

const TILE =
  "flex h-8 items-center justify-center transition-colors min-h-11 md:min-h-0 disabled:opacity-50 disabled:pointer-events-none";
const TILE_IDLE = "bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground";

/**
 * The call's own controls, at the foot of the channel list: where you are and
 * how well you are connected on top, everything you can do about it beneath.
 *
 * A tile is coloured only while it is doing something unusual — muted and
 * deafened in the destructive colour, a camera or screen going out in the
 * success/info colours — so a glance at the row says what is live.
 */
export function VoiceConnectedPanel({
  publisherState: s,
  quality,
  pingMs,
  roomName,
  channelName,
  isMuted,
  isDeafened,
  isWebcamActive,
  isScreenSharing,
  onToggleMute,
  onToggleDeafen,
  onToggleWebcam,
  onToggleScreenShare,
  onLeaveVoice,
}: VoiceConnectedPanelProps) {
  // Straight from the peer connection, which reports a change as it happens;
  // the quality numbers are sampled and only colour the bars once it is up.
  const isOk = s === "connected";
  const isBad = s === "failed" || s === "disconnected";
  const statusColor = isBad
    ? "text-destructive"
    : !isOk
      ? "text-warning"
      : quality === 1
        ? "text-destructive"
        : quality === 2
          ? "text-warning"
          : "text-success";
  const status =
    s === "connecting" || s === "new" ? "Connecting…" :
    s === "failed" ? "Connection Failed" :
    s === "disconnected" ? "Reconnecting…" :
    "Voice Connected";

  const silenced = isMuted || isDeafened;
  const showScreen = !!onToggleScreenShare && canShareScreen();

  return (
    <div className="shrink-0 border-t px-2 py-2 space-y-2">
      <div className="flex items-center gap-2 pl-1">
        <span
          className={`shrink-0 ${statusColor}`}
          title={pingMs != null ? `Ping ${pingMs} ms` : status}
        >
          <SignalBars quality={isOk ? quality : 0} />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className={`truncate text-xs font-semibold ${statusColor}`}>{status}</div>
          <div className="truncate text-3xs text-muted-foreground" title={channelName ? `${roomName} / ${channelName}` : roomName}>
            {channelName ? `${roomName} / ${channelName}` : roomName}
          </div>
        </div>
        {onLeaveVoice && (
          <button
            onClick={onLeaveVoice}
            className="flex size-8 min-h-11 min-w-11 md:min-h-0 md:min-w-0 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
            title="Disconnect"
            aria-label="Disconnect"
          >
            <PhoneOff className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex gap-1.5">
        <button
          onClick={onToggleMute}
          disabled={isDeafened}
          className={`${TILE} flex-1 rounded-md ${
            silenced ? "bg-destructive/15 text-destructive hover:bg-destructive/25" : TILE_IDLE
          }`}
          title={isDeafened ? "Undeafen to unmute" : isMuted ? "Unmute" : "Mute"}
          aria-label={isMuted ? "Unmute" : "Mute"}
          aria-pressed={silenced}
        >
          {silenced ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </button>
        <button
          onClick={onToggleDeafen}
          className={`${TILE} flex-1 rounded-md ${
            isDeafened ? "bg-destructive/15 text-destructive hover:bg-destructive/25" : TILE_IDLE
          }`}
          title={isDeafened ? "Undeafen" : "Deafen"}
          aria-label={isDeafened ? "Undeafen" : "Deafen"}
          aria-pressed={isDeafened}
        >
          {isDeafened ? <HeadphoneOff className="h-4 w-4" /> : <Headphones className="h-4 w-4" />}
        </button>
        {onToggleWebcam && (
          <button
            onClick={onToggleWebcam}
            className={`${TILE} flex-1 rounded-md ${
              isWebcamActive ? "bg-success/15 text-success hover:bg-success/25" : TILE_IDLE
            }`}
            title={isWebcamActive ? "Turn off camera" : "Turn on camera"}
            aria-label={isWebcamActive ? "Turn off camera" : "Turn on camera"}
            aria-pressed={!!isWebcamActive}
          >
            <Video className="h-4 w-4" />
          </button>
        )}
        {showScreen && (
          // A split tile: the face starts or stops the share, the narrow edge
          // opens its quality settings. One tile wide, like its neighbours.
          <div className="flex flex-1">
            <button
              onClick={onToggleScreenShare}
              className={`${TILE} flex-1 rounded-l-md ${
                isScreenSharing ? "bg-info/15 text-info hover:bg-info/25" : TILE_IDLE
              }`}
              title={isScreenSharing ? "Stop sharing" : "Share your screen"}
              aria-label={isScreenSharing ? "Stop sharing" : "Share your screen"}
              aria-pressed={!!isScreenSharing}
            >
              <ScreenShare className="h-4 w-4" />
            </button>
            <ScreenFpsMenu>
              <button
                className={`${TILE} w-4 shrink-0 rounded-r-md border-l border-background/50 ${
                  isScreenSharing ? "bg-info/15 text-info hover:bg-info/25" : TILE_IDLE
                }`}
                title="Screen share quality"
                aria-label="Screen share quality"
              >
                <ChevronUp className="h-3 w-3" />
              </button>
            </ScreenFpsMenu>
          </div>
        )}
      </div>
    </div>
  );
}
