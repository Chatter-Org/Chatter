/**
 * Keeping this phone's player on the room's shared timeline — the web's
 * WatchPartyArea logic, out of React so the half-second ticks redraw only
 * what shows the time.
 *
 * The server keeps one timeline per room: playing or not, a position, and
 * the server time it was taken at. Everyone works out where the video should
 * be from that, and nudges their own player when it has wandered more than a
 * second and a half. Anyone in the room may play, pause, seek or change it.
 */

export interface WatchState {
  videoUrl: string;
  playing: boolean;
  positionSecs: number;
  /** Unix seconds (the server's clock). */
  positionUpdatedAt: number;
}

/** What the screen's player (a file's, or YouTube's) can be told. */
export interface TheaterPlayer {
  seek(secs: number): void;
  play(): void;
  pause(): void;
}

/** A frame from the server: `watchparty_sync` or `watchparty_video_changed`. */
export interface SyncFrame {
  room_id: string;
  video_url?: string;
  playing: boolean;
  position_secs: number;
  position_updated_at: number;
  duration_secs?: number;
  sender_user_id?: string | null;
}

/** Re-seek once the player is further than this from the timeline; below it,
 *  a correction is a visible jump that is worse than the drift. */
const DRIFT_TOLERANCE_SECS = 1.5;
const DRIFT_CHECK_MS = 3000;
const TICK_MS = 500;
/** Players rarely report a position exactly at the end. */
export const END_EPSILON_SECS = 0.35;
/** A player reading older than this says nothing about where it is. */
const PLAYER_POSITION_STALE_MS = 10_000;
/** Leave a correction this long to land before considering another. */
const DRIFT_SETTLE_MS = 5000;
/** Stop waiting on a seek that never reports landing. */
const SEEK_ABANDON_MS = 15_000;
/** After applying the timeline, its own echoes are not drift. */
const APPLYING_GUARD_MS = 400;

const now = () => Date.now() / 1000;

export const EMPTY_WATCH: WatchState = { videoUrl: "", playing: false, positionSecs: 0, positionUpdatedAt: 0 };

/** Where the timeline says the video is now. */
export function expectedPosition(w: WatchState): number {
  return w.playing ? w.positionSecs + Math.max(0, now() - w.positionUpdatedAt) : w.positionSecs;
}

export class TheaterSync {
  watch: WatchState = EMPTY_WATCH;
  duration = 0;
  /** The position shown on the bar. */
  display = 0;
  private player: TheaterPlayer | null = null;
  /** YouTube's player reports no seeking, so it is always told. */
  private youtube = false;
  /** The bar is being dragged: the ticks leave its position alone. */
  scrubbing = false;

  private ready = false;
  private pending: { pos: number; playing: boolean } | null = null;
  private playerPos = 0;
  private playerPosAt = 0;
  private seekPending: { target: number; at: number } | null = null;
  private lastCorrectionAt = 0;
  private endReported = false;
  private applyingUntil = 0;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    private readonly me: string | null,
    private readonly send: (frame: Record<string, unknown>) => void,
    private readonly changed: () => void,
  ) {}

  start() {
    this.timers = [setInterval(() => this.tick(), TICK_MS), setInterval(() => this.checkDrift(), DRIFT_CHECK_MS)];
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  /** The state the server gave over REST on opening. */
  load(state: { video_url: string; playing: boolean; position_secs: number; position_updated_at: number; duration_secs: number }) {
    if (!state.video_url) return;
    this.setVideo({
      videoUrl: state.video_url,
      playing: state.playing,
      positionSecs: state.position_secs,
      positionUpdatedAt: state.position_updated_at,
    });
    if (state.duration_secs > 0) this.duration = state.duration_secs;
    this.changed();
  }

  /** A sync or a new video from the socket (already this room's). */
  receive(type: "watchparty_sync" | "watchparty_video_changed", msg: SyncFrame) {
    const prev = this.watch;
    const next: WatchState = {
      videoUrl: msg.video_url !== undefined ? msg.video_url : prev.videoUrl,
      playing: msg.playing,
      positionSecs: msg.position_secs,
      positionUpdatedAt: msg.position_updated_at,
    };
    if (type === "watchparty_video_changed" || next.videoUrl !== prev.videoUrl) {
      // A new player mounts for it, and takes this when it is ready.
      this.setVideo(next);
      this.duration = msg.duration_secs && msg.duration_secs > 0 ? msg.duration_secs : 0;
    } else {
      if (msg.duration_secs && msg.duration_secs > 0) this.duration = msg.duration_secs;
      this.watch = next;
      // Our own controls were applied as they were pressed; and a sync that
      // changes nothing (another phone's heartbeat) must not seek.
      if (msg.sender_user_id !== this.me) {
        const pos = expectedPosition(next);
        const playerNow = this.playerNow();
        if (prev.playing !== next.playing || playerNow === null || Math.abs(pos - playerNow) > DRIFT_TOLERANCE_SECS) {
          this.apply(pos, next.playing);
        }
      }
    }
    this.changed();
  }

  // ─── The player's reports ────────────────────────────────────────────────

  /** The player for the current video can take commands. */
  playerReady(player: TheaterPlayer | null, youtube: boolean) {
    this.player = player;
    this.youtube = youtube;
    if (this.ready) return;
    this.ready = true;
    const p = this.pending ?? { pos: expectedPosition(this.watch), playing: this.watch.playing };
    this.pending = null;
    this.apply(p.pos, p.playing);
  }

  playerPosition(secs: number) {
    this.playerPos = secs;
    this.playerPosAt = Date.now();
    if (this.seekPending && Math.abs(secs - this.seekPending.target) < 1) this.seekPending = null;
  }

  playerDuration(secs: number) {
    if (!Number.isFinite(secs) || secs <= 0 || secs === this.duration) return;
    this.duration = secs;
    this.changed();
  }

  playerEnded() {
    this.reportEnded();
  }

  // ─── This person's controls ──────────────────────────────────────────────

  togglePlay() {
    const playing = !this.watch.playing;
    // Play at the end starts it again, as any player does; otherwise the
    // timeline would run on past the end with nothing to show.
    const atEnd = this.duration > 0 && this.display >= this.duration - END_EPSILON_SECS;
    const pos = playing && atEnd ? 0 : this.display;
    this.send({ type: "watchparty_control", playing, position_secs: pos, duration_secs: this.duration > 0 ? this.duration : undefined });
    this.watch = { ...this.watch, playing, positionSecs: pos, positionUpdatedAt: now() };
    this.apply(pos, playing);
  }

  /** The bar let go of at `pos`. */
  seekTo(pos: number) {
    this.scrubbing = false;
    this.send({ type: "watchparty_control", playing: this.watch.playing, position_secs: pos });
    this.watch = { ...this.watch, positionSecs: pos, positionUpdatedAt: now() };
    this.apply(pos, this.watch.playing);
  }

  scrub(pos: number) {
    this.scrubbing = true;
    this.display = pos;
    this.changed();
  }

  // ─── Inside ──────────────────────────────────────────────────────────────

  private setVideo(next: WatchState) {
    this.watch = next;
    this.ready = false;
    this.pending = { pos: expectedPosition(next), playing: next.playing };
    this.playerPosAt = 0;
    this.seekPending = null;
    this.endReported = false;
    this.display = this.pending.pos;
  }

  /** Where the player is now, from its last reading; null with none fresh. */
  private playerNow(): number | null {
    if (this.playerPosAt === 0 || Date.now() - this.playerPosAt > PLAYER_POSITION_STALE_MS) return null;
    return this.playerPos + (this.watch.playing ? (Date.now() - this.playerPosAt) / 1000 : 0);
  }

  private apply(pos: number, playing: boolean) {
    this.display = pos;
    this.changed();
    if (!this.player || !this.ready) {
      this.pending = { pos, playing };
      return;
    }
    this.applyingUntil = Date.now() + APPLYING_GUARD_MS;
    if (this.youtube) {
      this.player.seek(pos);
    } else {
      // A seek already on its way to about here is left to land.
      const landing = this.seekPending && Date.now() - this.seekPending.at < SEEK_ABANDON_MS && Math.abs(this.seekPending.target - pos) <= DRIFT_TOLERANCE_SECS;
      const at = this.playerNow();
      if (!landing && (at === null || Math.abs(at - pos) > 0.25)) {
        this.player.seek(pos);
        this.seekPending = { target: pos, at: Date.now() };
      }
    }
    this.lastCorrectionAt = Date.now();
    if (playing) this.player.play();
    else this.player.pause();
  }

  private tick() {
    if (!this.watch.playing || !this.watch.videoUrl) return;
    const raw = expectedPosition(this.watch);
    if (this.duration > 0 && raw < this.duration - END_EPSILON_SECS) this.endReported = false;
    if (!this.scrubbing) {
      this.display = this.duration > 0 ? Math.min(raw, this.duration) : raw;
      this.changed();
    }
    if (this.duration > 0 && raw >= this.duration - END_EPSILON_SECS) this.reportEnded();
  }

  private checkDrift() {
    if (!this.ready || !this.player || !this.watch.playing || Date.now() < this.applyingUntil) return;
    const expected = expectedPosition(this.watch);
    if (this.duration > 0 && expected >= this.duration - END_EPSILON_SECS) return;
    const at = this.playerNow();
    if (at === null) return;
    if (this.seekPending && Date.now() - this.seekPending.at < SEEK_ABANDON_MS) return;
    if (Date.now() - this.lastCorrectionAt < DRIFT_SETTLE_MS) return;
    if (Math.abs(expected - at) > DRIFT_TOLERANCE_SECS) this.apply(expected, true);
  }

  /** The video reached its end: once per playthrough, paused at the end for
   *  everyone (the server ignores it from all but the first). */
  private reportEnded() {
    if (this.endReported || !this.watch.playing) return;
    this.endReported = true;
    const end = this.duration > 0 ? this.duration : this.display;
    this.watch = { ...this.watch, playing: false, positionSecs: end, positionUpdatedAt: now() };
    this.display = end;
    this.send({ type: "watchparty_ended" });
    this.changed();
  }
}

/** The web's YouTube link forms. */
export function youTubeId(url: string): string | null {
  const m = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&?/\s]+)/.exec(url);
  return m ? m[1] : null;
}

/** h:mm:ss, or m:ss under an hour. */
export function formatTime(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
