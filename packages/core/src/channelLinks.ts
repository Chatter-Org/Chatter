import type { Channel } from "./api";
import type { MentionMatch } from "./mentions";
import type { AppState } from "./store/types";
import { memberCanViewChannel } from "./permissions";

/**
 * Links to a channel: `#general` in the composer, `<#channel_id>` on the wire.
 *
 * The body carries the id, never the name, for two reasons. A rename reaches
 * every message that ever linked the channel. And the name of a private channel
 * is itself private: a link to it sits in a channel whose members may not be
 * allowed to know it exists. So the name is looked up by each *reader*, against
 * the channels they can see, and anyone who cannot see it reads `#unknown`.
 * The server does the same for push (`render_channel_links` in `push.rs`).
 *
 * Channel ids start with `#`, so a link reads `<##_…>` in the raw body.
 */

/** A channel link in a message body. Port: `CHANNEL_LINK` in `push.rs`. */
export const CHANNEL_LINK = /<#([^\s<>]+)>/g;

/** What a reader who cannot see the channel is shown in its place. */
export const UNKNOWN_CHANNEL = "unknown";

export type LinkableChannel = Pick<Channel, "channel_id" | "name" | "channel_type">;

/** The channels the signed-in user can see in the open room — what a link
 *  resolves against. The server already leaves out channels the user cannot
 *  view; this re-checks against the overwrites held, so a channel made private
 *  while the client was open stops resolving without a reload. */
export function visibleChannels(state: Pick<AppState, "channels" | "userId" | "roomMembers" | "customRoles" | "memberCustomRoles">): Channel[] {
  const me = state.userId;
  if (!me) return [];
  const role = state.roomMembers.find((m) => m.userId === me)?.role ?? "member";
  const roles = { customRoles: state.customRoles, memberCustomRoles: state.memberCustomRoles };
  return state.channels.filter((ch) => memberCanViewChannel(roles, ch, { userId: me, role }));
}

/** Voice channels are named in a link but not opened by one: clicking would
 *  join the call. */
export function channelLinkOpens(channel: LinkableChannel): boolean {
  return channel.channel_type !== "voice" && channel.channel_type !== "spatial";
}

/** Channels whose name starts with — then contains — what follows the "#". */
export function findChannelMatches<C extends LinkableChannel>(channels: C[], search: string): C[] {
  const needle = search.toLowerCase();
  const starts = channels.filter((c) => c.name.toLowerCase().startsWith(needle));
  const contains = channels.filter(
    (c) => !c.name.toLowerCase().startsWith(needle) && c.name.toLowerCase().includes(needle),
  );
  return [...starts, ...contains].slice(0, 8);
}

/** The same, shaped for the composer's mention menu. */
export function channelMentionMatches(channels: LinkableChannel[], search: string): MentionMatch[] {
  return findChannelMatches(channels, search).map((c) => ({
    kind: "channel",
    id: c.channel_id,
    name: c.name,
    color: undefined,
  }));
}

/** Split off fenced code, which keeps what was typed verbatim. */
function mapOutsideCode(text: string, fn: (chunk: string) => string): string {
  return text
    .split(/(```[\s\S]*?```)/)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}

/**
 * The composer's text as it is sent: each `#name` naming one of `channels`
 * becomes `<#id>`. A `#` counts only at the start or after a space or "(", so
 * a URL fragment stays a URL. Names may hold spaces, so the longest name that
 * fits wins, and a name must end at a word boundary — `#general` is not a link
 * to `gen`. Text that names no channel is sent as typed.
 */
export function encodeChannelLinks(text: string, channels: LinkableChannel[]): string {
  if (!text.includes("#") || channels.length === 0) return text;
  const byLength = [...channels].sort((a, b) => b.name.length - a.name.length);
  return mapOutsideCode(text, (chunk) => {
    let out = "";
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i];
      if (ch === "#" && (i === 0 || /[\s(]/.test(chunk[i - 1]))) {
        const rest = chunk.slice(i + 1);
        const restLower = rest.toLowerCase();
        let found: LinkableChannel | null = null;
        for (const c of byLength) {
          if (found && c.name.length < found.name.length) break;
          if (!c.name || !restLower.startsWith(c.name.toLowerCase())) continue;
          if (/[\w-]/.test(rest.charAt(c.name.length))) continue;
          // Of two names the same length, the one typed in the same case.
          if (!found || (!rest.startsWith(found.name) && rest.startsWith(c.name))) found = c;
        }
        if (found) {
          out += `<#${found.channel_id}>`;
          i += 1 + found.name.length;
          continue;
        }
      }
      out += ch;
      i++;
    }
    return out;
  });
}

/** The inverse, for putting a sent message back in a composer to edit. A link
 *  this reader cannot resolve is left as the raw token, so saving the edit
 *  keeps it rather than turning it into the literal text "#unknown". */
export function decodeChannelLinks(body: string, channels: LinkableChannel[]): string {
  if (!body.includes("<#")) return body;
  return body.replace(CHANNEL_LINK, (token, id: string) => {
    const channel = channels.find((c) => c.channel_id === id);
    return channel ? `#${channel.name}` : token;
  });
}

/** A body as plain text — a reply quote, a notification, a preview row. */
export function plainChannelLinks(body: string, channels: LinkableChannel[]): string {
  if (!body.includes("<#")) return body;
  return body.replace(CHANNEL_LINK, (_token, id: string) => {
    const channel = channels.find((c) => c.channel_id === id);
    return `#${channel ? channel.name : UNKNOWN_CHANNEL}`;
  });
}
