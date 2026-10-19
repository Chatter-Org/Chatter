import type { AppState } from "./store/types";

export interface MentionMatch {
  kind: "user" | "role";
  id: string;
  name: string;
  color: string | undefined;
}

/** Members and roles whose name starts with what follows the "@". Shared by
 *  the channel and thread composers so the two cannot offer different lists. */
export function findMentionMatches(state: AppState, search: string): MentionMatch[] {
  const needle = search.toLowerCase();
  const roomInfo = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : null;
  const builtInRoles: MentionMatch[] = [];
  for (const r of [{ name: "owner", color: roomInfo?.owner_name_color }, { name: "moderator", color: roomInfo?.mod_name_color }]) {
    if (r.name.startsWith(needle)) {
      builtInRoles.push({ kind: "role", id: `builtin-${r.name}`, name: r.name, color: r.color || undefined });
    }
  }
  return [
    ...state.roomMembers
      .filter((m) => m.displayName.toLowerCase().startsWith(needle))
      .slice(0, 5)
      .map((m): MentionMatch => ({ kind: "user", id: m.userId, name: m.displayName, color: undefined })),
    ...builtInRoles,
    ...state.customRoles
      .filter((r) => r.name.toLowerCase().startsWith(needle))
      .slice(0, 5)
      .map((r): MentionMatch => ({ kind: "role", id: r.role_id, name: r.name, color: r.color || undefined })),
  ].slice(0, 8);
}

/** Lowercase role name → its colour ("" for none): what an `@role` in a body
 *  is drawn in. Shared by the timeline and the forum so a role reads the same
 *  in both. */
export function mentionRoleColors(
  customRoles: AppState["customRoles"],
  roomInfo: { owner_name_color?: string; mod_name_color?: string } | null | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  map.set("owner", roomInfo?.owner_name_color || "");
  map.set("moderator", roomInfo?.mod_name_color || "");
  for (const role of customRoles) {
    map.set(role.name.toLowerCase(), role.color || "");
  }
  return map;
}

/** The same map with every colour passed through `readable` — a role colour
 *  picked on one theme, made legible on the one it is drawn on. An empty
 *  colour stays empty: it means "no colour", which draws the primary style. */
export function readableRoleColors(
  colors: Map<string, string>,
  readable: (color: string) => string,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, color] of colors) out.set(name, color ? readable(color) : "");
  return out;
}
