import { describe, it, expect } from "vitest";
import { toResponseStatus } from "@/lib/calendar/attendance";

/** Two providers, seven spellings, one enum.
 *
 * Worth testing exhaustively because every one of these is a string somebody
 * else chose, and the failure mode of getting one wrong is silent: a person who
 * accepted shows as not having replied, and the tool reads as broken to the one
 * user who checked. */

describe("reading Google's answers", () => {
  it("maps every status Google actually sends", () => {
    expect(toResponseStatus("google", "accepted")).toBe("yes");
    expect(toResponseStatus("google", "declined")).toBe("no");
    expect(toResponseStatus("google", "tentative")).toBe("maybe");
    expect(toResponseStatus("google", "needsAction")).toBe("noreply");
  });

  it("doesn't care about casing", () => {
    expect(toResponseStatus("google", "NeedsAction")).toBe("noreply");
    expect(toResponseStatus("google", " ACCEPTED ")).toBe("yes");
  });
});

describe("reading Microsoft's answers", () => {
  it("maps every status Graph actually sends", () => {
    expect(toResponseStatus("microsoft", "accepted")).toBe("yes");
    expect(toResponseStatus("microsoft", "declined")).toBe("no");
    expect(toResponseStatus("microsoft", "tentativelyAccepted")).toBe("maybe");
    expect(toResponseStatus("microsoft", "none")).toBe("noreply");
    expect(toResponseStatus("microsoft", "notResponded")).toBe("noreply");
  });

  it("counts the organiser as going", () => {
    // Graph reports the mailbox owner as `organizer`, not `accepted`. Reading
    // that as "no answer" would put the session lead in the same bucket as a
    // guest who never opened the invite — for a meeting they are hosting.
    expect(toResponseStatus("microsoft", "organizer")).toBe("yes");
  });

  it("does not borrow Google's vocabulary", () => {
    // `tentative` is Google's word; Graph says `tentativelyAccepted`. If Graph
    // ever sends this it means something has changed, and guessing is the wrong
    // response.
    expect(toResponseStatus("microsoft", "tentative")).toBeNull();
    expect(toResponseStatus("google", "tentativelyAccepted")).toBeNull();
  });
});

describe("anything unrecognised", () => {
  // The property the whole feature rests on. A value we don't understand means
  // "no new information", and must never be flattened to noreply — that would
  // erase a real acceptance the previous run had read correctly, which is the
  // one outcome that makes this worse than not having the feature at all.
  it("is null, never a default", () => {
    expect(toResponseStatus("google", "somethingNew")).toBeNull();
    expect(toResponseStatus("microsoft", "somethingNew")).toBeNull();
  });

  it("treats a missing answer as unrecognised too", () => {
    expect(toResponseStatus("google", undefined)).toBeNull();
    expect(toResponseStatus("google", "")).toBeNull();
  });
});
