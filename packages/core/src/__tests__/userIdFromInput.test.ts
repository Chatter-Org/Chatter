import { describe, expect, it } from "vitest";
import { userIdFromInput } from "../utils";

describe("userIdFromInput", () => {
  it("takes the server from the caller's own id", () => {
    expect(userIdFromInput("bob", "@alice:chat.example")).toBe("@bob:chat.example");
  });
  it("accepts a leading @ and stray spaces", () => {
    expect(userIdFromInput("  @bob ", "@alice:localhost")).toBe("@bob:localhost");
  });
  it("leaves a full id alone", () => {
    expect(userIdFromInput("@bob:other", "@alice:localhost")).toBe("@bob:other");
  });
  it("falls back to localhost before sign-in", () => {
    expect(userIdFromInput("bob", null)).toBe("@bob:localhost");
  });
});
