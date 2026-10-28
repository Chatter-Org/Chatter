import { describe, it, expect } from "vitest";
import { groupMembers } from "../memberGroups";
import type { CustomRole, RolePermissions } from "../api";

const role = (role_id: string, position: number, hoist: boolean): CustomRole => ({
  role_id,
  room_id: "r",
  name: role_id.toUpperCase(),
  color: "",
  position,
  permissions: {} as RolePermissions,
  hoist,
});

const m = (userId: string, r = "member") => ({ userId, role: r });

describe("groupMembers", () => {
  const roles = [role("staff", 0, true), role("vip", 1, true), role("quiet", 2, false)];
  const offline = new Set(["gone"]);
  const online = (id: string) => !offline.has(id);

  it("lists owner, moderators, hoisted roles in rank order, members, offline", () => {
    const groups = groupMembers(
      [m("a"), m("b"), m("own", "owner"), m("mod", "moderator"), m("c"), m("gone")],
      online,
      roles,
      { a: ["vip"], b: ["staff"], c: ["quiet"], gone: ["staff"] },
    );
    expect(groups.map((g) => [g.label, g.members.map((x) => x.userId)])).toEqual([
      ["Owner", ["own"]],
      ["Moderators", ["mod"]],
      ["STAFF", ["b"]],
      ["VIP", ["a"]],
      ["Members", ["c"]],
      ["Offline", ["gone"]],
    ]);
  });

  it("puts someone with two hoisted roles under the higher one only", () => {
    const groups = groupMembers([m("a")], online, roles, { a: ["vip", "staff"] });
    expect(groups.map((g) => g.label)).toEqual(["STAFF"]);
  });

  it("keeps owners and moderators under their own headings", () => {
    const groups = groupMembers([m("own", "owner")], online, roles, { own: ["staff"] });
    expect(groups.map((g) => g.label)).toEqual(["Owner"]);
  });

  it("treats roles from a server without the setting as not hoisted", () => {
    const old = { ...role("x", 0, false), hoist: undefined };
    const groups = groupMembers([m("a")], online, [old], { a: ["x"] });
    expect(groups.map((g) => g.label)).toEqual(["Members"]);
  });
});
