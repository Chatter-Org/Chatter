import type { CustomRole } from "./api";

export interface MemberGroup<M> {
  /** Stable key for React: "owner", "moderator", "role:<id>", "members", "offline". */
  key: string;
  label: string;
  members: M[];
}

/**
 * Splits a members list into its headings: the owner, moderators, one heading
 * per role with `hoist` set, everyone else online, then everyone offline.
 *
 * Owners and moderators stay under their own headings whatever roles they
 * hold. Anyone else goes under the highest hoisted role they hold (lowest
 * `position`, as the server ranks roles); hoisted roles are listed in that
 * order. Offline members are one heading whatever their role. Empty groups are
 * left out, and the input order is kept within each group.
 */
export function groupMembers<M extends { userId: string; role: string }>(
  members: M[],
  isOnline: (userId: string) => boolean,
  customRoles: CustomRole[],
  memberCustomRoles: Record<string, string[]>,
): MemberGroup<M>[] {
  const hoisted = customRoles
    .filter((r) => r.hoist)
    .sort((a, b) => a.position - b.position);

  const owners: M[] = [];
  const moderators: M[] = [];
  const byRole = new Map<string, M[]>(hoisted.map((r) => [r.role_id, []]));
  const rest: M[] = [];
  const offline: M[] = [];

  for (const m of members) {
    if (!isOnline(m.userId)) offline.push(m);
    else if (m.role === "owner") owners.push(m);
    else if (m.role === "moderator") moderators.push(m);
    else {
      const held = memberCustomRoles[m.userId] ?? [];
      const top = hoisted.find((r) => held.includes(r.role_id));
      (top ? byRole.get(top.role_id)! : rest).push(m);
    }
  }

  const groups: MemberGroup<M>[] = [
    { key: "owner", label: "Owner", members: owners },
    { key: "moderator", label: "Moderators", members: moderators },
    ...hoisted.map((r) => ({
      key: `role:${r.role_id}`,
      label: r.name,
      members: byRole.get(r.role_id)!,
    })),
    { key: "members", label: "Members", members: rest },
    { key: "offline", label: "Offline", members: offline },
  ];
  return groups.filter((g) => g.members.length > 0);
}
