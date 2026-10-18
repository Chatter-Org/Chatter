import { describe, it, expect } from "vitest";
import { candidatesAfterOffer } from "../webrtc";

describe("candidatesAfterOffer", () => {
  it("holds candidates until the offer is sent, then sends them in order", () => {
    const sent: string[] = [];
    const trickle = candidatesAfterOffer<string>((c) => sent.push(c));
    trickle.add("a");
    trickle.add("b");
    expect(sent).toEqual([]);
    trickle.offerSent();
    expect(sent).toEqual(["a", "b"]);
  });

  it("sends candidates straight through once the offer is out", () => {
    const sent: string[] = [];
    const trickle = candidatesAfterOffer<string>((c) => sent.push(c));
    trickle.offerSent();
    trickle.add("c");
    expect(sent).toEqual(["c"]);
  });

  it("never sends a held candidate twice", () => {
    const sent: string[] = [];
    const trickle = candidatesAfterOffer<string>((c) => sent.push(c));
    trickle.add("a");
    trickle.offerSent();
    trickle.offerSent();
    expect(sent).toEqual(["a"]);
  });
});
