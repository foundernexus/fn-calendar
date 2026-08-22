import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createTestDb, reinstallTestDb, type TestDb } from "@/test/db";
import { events } from "@/db/schema";
import {
  adminCookie,
  memberCookie,
  jsonRequest,
  mockCookies,
  seedMember,
  seedConnection,
} from "@/test/helpers";

/** TEMPORARY — audit validation, not a permanent suite.
 *
 * Every test here checks the SECOND half of a feature: not "did the write
 * succeed" but "did the result turn up everywhere it should". A booking that
 * saves but never appears on the advisor's dashboard is a failed feature, not a
 * passing one. */

let harness: TestDb;

type CreateArgs = {
  participants: { email: string; name?: string }[];
  recurrenceRule?: string;
};

const cal = {
  create: vi.fn(async (_a: CreateArgs) => ({ eventId: "provider-event-1" })),
  cancel: vi.fn(async (_a: unknown) => ({ ok: true })),
  move: vi.fn(async (_a: unknown) => ({ ok: true })),
  /** The two candidate slots a search should surface, PLUS the window it was
   * asked about.
   *
   * The echo is what makes a repeating booking testable: the guard asks about
   * one narrow window per date, and a fixed list would report every date after
   * the first as busy — a difference only visible once something asks about
   * more than one date. */
  availability: vi.fn(async (args?: { startTime: number; endTime: number }) => ({
    slots: [
      { startTime: SLOT, endTime: SLOT + 3600 },
      { startTime: LATER, endTime: LATER + 3600 },
      ...(args ? [{ startTime: args.startTime, endTime: args.endTime }] : []),
    ],
    unreadable: [] as string[],
  })),
  /** Dates the availability mock should report as taken. */
  busyDates: new Set<number>(),
};

vi.mock("@/lib/calendar/events", () => ({
  createSessionEvent: (a: CreateArgs) => cal.create(a),
  cancelSessionEvent: (a: unknown) => cal.cancel(a),
  moveSessionEvent: (a: unknown) => cal.move(a),
}));
vi.mock("@/lib/calendar/availability", () => ({
  getCollectiveAvailability: (args: { startTime: number; endTime: number }) =>
    cal.busyDates.has(args.startTime)
      ? Promise.resolve({ slots: [], unreadable: [] as string[] })
      : cal.availability(args),
}));

/** Wednesday 2026-09-02, 10:00 Pacific. */
const SLOT = Math.floor(new Date("2026-09-02T17:00:00Z").getTime() / 1000);
const LATER = SLOT + 2 * 3600;

beforeAll(async () => {
  harness = await createTestDb();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await harness.reset();
  vi.clearAllMocks();
  cal.busyDates.clear();
  cal.create.mockResolvedValue({ eventId: "provider-event-1" });
  vi.resetModules();
  mockCookies(await adminCookie());
  await reinstallTestDb();
});

async function cast() {
  const lead = await seedMember({
    email: "tobias@foundernexus.com",
    fullName: "Tobias",
    isFacilitator: true,
  });
  const advisor = await seedMember({
    email: "court@foundernexus.com",
    fullName: "Court",
    isAdvisor: true,
  });
  const founder = await seedMember({ email: "yuan@example.com", fullName: "Yuan" });
  for (const m of [lead, advisor, founder]) {
    await seedConnection({ memberId: m.id, grantEmail: m.email, grantId: `g-${m.id}` });
  }
  return { lead, advisor, founder };
}

async function book(c: Awaited<ReturnType<typeof cast>>, over: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/admin/events/route");
  const res = await POST(
    jsonRequest(
      "http://localhost/api/admin/events",
      {
        organizerMemberId: c.lead.id,
        advisorMemberId: c.advisor.id,
        guestMemberIds: [c.founder.id],
        title: "Expert session",
        startsAtUnix: SLOT,
        durationMinutes: 60,
        timezone: "America/Los_Angeles",
        ...over,
      },
      { cookie: await adminCookie() }
    )
  );
  return { res, body: await res.json() };
}

/** The grid's own source of already-booked cells. */
async function gridBookings(memberIds: number[]) {
  const { getBookedEventsOverlapping } = await import("@/db/queries");
  return getBookedEventsOverlapping(
    memberIds,
    new Date((SLOT - 86_400) * 1000),
    new Date((SLOT + 86_400) * 1000)
  );
}

/** What /advisor renders. */
async function advisorSessions(memberId: number) {
  const { getSessionsForMember } = await import("@/db/queries");
  return getSessionsForMember(memberId);
}

describe("D10 — a booked session turns up everywhere it should", () => {
  it("is visible on the grid, on the advisor's dashboard, and blocks removal", async () => {
    const c = await cast();
    const { res } = await book(c);
    expect(res.status).toBe(200);

    // 1. The grid an admin looks at next.
    const onGrid = await gridBookings([c.lead.id, c.advisor.id, c.founder.id]);
    expect(onGrid).toHaveLength(1);
    expect(onGrid[0].title).toBe("Expert session");
    expect(onGrid[0].attendees.length).toBe(3);

    // 2. The advisor's own dashboard — the view most likely to be forgotten,
    //    because nothing an admin does ever renders it.
    const forAdvisor = await advisorSessions(c.advisor.id);
    expect(forAdvisor).toHaveLength(1);

    // 3. And the founder's, who is neither organiser nor advisor.
    expect(await advisorSessions(c.founder.id)).toHaveLength(1);

    // 4. Removing someone in a confirmed session must now be refused — the
    //    guard reads the same rows.
    mockCookies(await adminCookie());
    const { DELETE } = await import("@/app/api/admin/members/[id]/route");
    const del = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ id: String(c.founder.id) }),
    });
    expect(del.status).toBe(409);
  });

  it("invites the address the member nominated, not their registered one", async () => {
    const lead = await seedMember({ email: "tobias@foundernexus.com", isFacilitator: true });
    const founder = await seedMember({ email: "registered@work.com", fullName: "Yuan" });
    await seedConnection({ memberId: lead.id, grantEmail: lead.email, grantId: "g-l" });
    await seedConnection({
      memberId: founder.id,
      grantEmail: "work@gmail.com",
      grantId: "g-f1",
      isPrimary: false,
    });
    await seedConnection({
      memberId: founder.id,
      grantEmail: "chosen@gmail.com",
      grantId: "g-f2",
      isPrimary: true,
    });

    const { POST } = await import("@/app/api/admin/events/route");
    await POST(
      jsonRequest(
        "http://localhost/api/admin/events",
        {
          organizerMemberId: lead.id,
          guestMemberIds: [founder.id],
          title: "x",
          startsAtUnix: SLOT,
          durationMinutes: 60,
          timezone: "America/Los_Angeles",
        },
        { cookie: await adminCookie() }
      )
    );

    const invited = cal.create.mock.calls[0]![0].participants.map((p) => p.email);
    expect(invited).toContain("chosen@gmail.com");
    expect(invited).not.toContain("work@gmail.com");
    expect(invited).not.toContain("registered@work.com");
  });
});

describe("D15 — cancelling clears it from every view", () => {
  it("removes it from the grid and from both dashboards", async () => {
    const c = await cast();
    const { body } = await book(c);
    const eventId = body.event.id;

    mockCookies(await adminCookie());
    const { DELETE } = await import("@/app/api/admin/events/[id]/route");
    const res = await DELETE(new Request("http://localhost", { method: "DELETE" }), {
      params: Promise.resolve({ id: String(eventId) }),
    });
    expect(res.status).toBe(200);

    // Gone from the grid: it no longer occupies a slot anyone could click.
    expect(await gridBookings([c.lead.id, c.advisor.id, c.founder.id])).toHaveLength(0);

    // But NOT gone from the dashboards — it stays, marked cancelled, and
    // advisor-session-list renders it struck through with a Cancelled badge.
    // That is the better behaviour: a session that silently disappears leaves
    // an advisor wondering whether they imagined it. Asserted rather than
    // assumed, because the first draft of this audit had it the other way
    // round and would have reported a working feature as broken.
    const forAdvisor = await advisorSessions(c.advisor.id);
    expect(forAdvisor).toHaveLength(1);
    expect(forAdvisor[0].status).toBe("cancelled");

    // And it was actually withdrawn at the provider, not just hidden locally.
    expect(cal.cancel).toHaveBeenCalledTimes(1);

    // A cancelled session must no longer block removing the person: it never
    // happened, so there is no history to protect.
    mockCookies(await adminCookie());
    const { DELETE: removeMember } = await import("@/app/api/admin/members/[id]/route");
    const removed = await removeMember(new Request("http://localhost"), {
      params: Promise.resolve({ id: String(c.founder.id) }),
    });
    expect(removed.status).toBe(200);
  });
});

describe("D14 — rescheduling moves it everywhere at once", () => {
  it("shows the new time on the grid and on the advisor's dashboard", async () => {
    const c = await cast();
    const { body } = await book(c);

    mockCookies(await adminCookie());
    const { PATCH } = await import("@/app/api/admin/events/[id]/route");
    const res = await PATCH(
      jsonRequest(
        "http://localhost",
        { startsAtUnix: LATER, durationMinutes: 60, timezone: "America/Los_Angeles" },
        { cookie: await adminCookie(), method: "PATCH" }
      ),
      { params: Promise.resolve({ id: String(body.event.id) }) }
    );
    expect(res.status).toBe(200);

    const onGrid = await gridBookings([c.lead.id, c.advisor.id, c.founder.id]);
    expect(onGrid).toHaveLength(1);
    expect(Math.floor(onGrid[0].startsAt.getTime() / 1000)).toBe(LATER);

    const forAdvisor = await advisorSessions(c.advisor.id);
    expect(Math.floor(forAdvisor[0].startsAt.getTime() / 1000)).toBe(LATER);

    // Moved, not cancelled-and-rebooked — attendees get an update.
    expect(cal.move).toHaveBeenCalledTimes(1);
    expect(cal.cancel).not.toHaveBeenCalled();
  });

  it("refuses to move a session onto a time someone blocked", async () => {
    // Rescheduling had no checks at all — not the stated hours, not the
    // calendars — while booking had both. The gap was never a decision, and it
    // meant a founder's stated hours could be walked around simply by booking
    // a valid time and then dragging the session somewhere else.
    const c = await cast();
    const { body } = await book(c);

    mockCookies(await memberCookie(c.founder.id));
    await reinstallTestDb();
    const { PATCH: saveMe } = await import("@/app/api/me/route");
    await saveMe(
      jsonRequest(
        "http://localhost/api/me",
        {
          timezone: "America/Los_Angeles",
          // Wednesdays 09:00–11:00 only: covers SLOT (10:00), not LATER (12:00).
          availability: [{ dayOfWeek: 3, startTime: "09:00", endTime: "11:00" }],
        },
        { cookie: await memberCookie(c.founder.id), method: "PATCH" }
      )
    );

    vi.resetModules();
    mockCookies(await adminCookie());
    await reinstallTestDb();
    const { PATCH } = await import("@/app/api/admin/events/[id]/route");
    const res = await PATCH(
      jsonRequest(
        "http://localhost",
        { startsAtUnix: LATER, durationMinutes: 60, timezone: "America/Los_Angeles" },
        { cookie: await adminCookie(), method: "PATCH" }
      ),
      { params: Promise.resolve({ id: String(body.event.id) }) }
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not available then/i);
    // And the session is still where it was — a refused move must not half-apply.
    const stillThere = await gridBookings([c.lead.id, c.founder.id]);
    expect(Math.floor(stillThere[0].startsAt.getTime() / 1000)).toBe(SLOT);
  });
});

describe("B1 — stated availability actually reaches the search", () => {
  it("removes slots outside a member's own hours", async () => {
    const c = await cast();

    // Yuan says Wednesdays 09:00–10:00 Pacific only, which covers SLOT but not
    // LATER (12:00).
    mockCookies(await memberCookie(c.founder.id));
    await reinstallTestDb();
    const { PATCH } = await import("@/app/api/me/route");
    const saved = await PATCH(
      jsonRequest(
        "http://localhost/api/me",
        {
          timezone: "America/Los_Angeles",
          availability: [{ dayOfWeek: 3, startTime: "09:00", endTime: "11:00" }],
        },
        { cookie: await memberCookie(c.founder.id), method: "PATCH" }
      )
    );
    expect(saved.status).toBe(200);

    vi.resetModules();
    mockCookies(await adminCookie());
    await reinstallTestDb();
    const { POST } = await import("@/app/api/admin/availability/route");
    const res = await POST(
      jsonRequest(
        "http://localhost/api/admin/availability",
        {
          organizerMemberId: c.lead.id,
          advisorMemberId: c.advisor.id,
          guestMemberIds: [c.founder.id],
          startDate: "2026-09-02",
          endDate: "2026-09-02",
          durationMinutes: 60,
          workingHoursStart: "09:00",
          workingHoursEnd: "17:00",
          timezone: "America/Los_Angeles",
          excludeWeekends: true,
        },
        { cookie: await adminCookie() }
      )
    );
    const out = await res.json();

    // 10:00 survives (inside his window), 12:00 does not.
    const starts = out.slots.map((s: { startUnix: number }) => s.startUnix);
    expect(starts).toContain(SLOT);
    expect(starts).not.toContain(LATER);
  });
});

describe("B1 — stated hours are a rule, not a suggestion", () => {
  it("refuses to book a time the member said they were unavailable for", async () => {
    // The audit found the opposite: this returned 200 and booked them. It was
    // a documented decision ("the admin's to override here") and the grid never
    // offered such a slot — but any other way in (a stale tab, the reschedule
    // flow, a retry) went straight through, so a founder's stated hours held
    // only as long as nobody took an unusual path.
    const c = await cast();

    mockCookies(await memberCookie(c.founder.id));
    await reinstallTestDb();
    const { PATCH } = await import("@/app/api/me/route");
    await PATCH(
      jsonRequest(
        "http://localhost/api/me",
        {
          timezone: "America/Los_Angeles",
          // Mondays only — nothing on the Wednesday being booked.
          availability: [{ dayOfWeek: 1, startTime: "09:00", endTime: "10:00" }],
        },
        { cookie: await memberCookie(c.founder.id), method: "PATCH" }
      )
    );

    vi.resetModules();
    mockCookies(await adminCookie());
    await reinstallTestDb();
    const { res, body } = await book(c);

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/not available then/i);
    // And nothing reached anyone's calendar — the refusal happens before the
    // provider is touched, so there is no invitation to withdraw.
    expect(cal.create).not.toHaveBeenCalled();
  });

  it("still books someone who never stated any hours", async () => {
    // The other half. Treating "never saved" as "available never" would lock
    // out every member who has not visited /me yet, which is most of them.
    const c = await cast();
    const { res } = await book(c);
    expect(res.status).toBe(200);
  });
});

describe("E3/E5 — the People list reflects adds and removals", () => {
  it("shows a new person as waiting to connect, in the right role", async () => {
    const { POST } = await import("@/app/api/admin/members/route");
    const res = await POST(
      jsonRequest(
        "http://localhost/api/admin/members",
        { fullName: "New Advisor", email: "new@advisor.com", isAdvisor: true },
        { cookie: await adminCookie() }
      )
    );
    expect(res.status).toBe(200);

    const { getMembersWithConnectionStatus } = await import("@/db/queries");
    const listed = (await getMembersWithConnectionStatus()).find(
      (m) => m.email === "new@advisor.com"
    );
    expect(listed).toBeDefined();
    expect(listed!.isAdvisor).toBe(true);
    expect(listed!.connected).toBe(false);
  });

  it("removes someone from the list, and from the pickers with it", async () => {
    const c = await cast();
    mockCookies(await adminCookie());
    const { DELETE } = await import("@/app/api/admin/members/[id]/route");
    const res = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ id: String(c.founder.id) }),
    });
    expect(res.status).toBe(200);

    const { getMembersWithConnectionStatus } = await import("@/db/queries");
    const all = await getMembersWithConnectionStatus();
    expect(all.find((m) => m.id === c.founder.id)).toBeUndefined();
  });
});

describe("a repeating session", () => {
  /** Four weeks on from SLOT, at the same wall-clock time. */
  const FOUR_WEEKS = Math.floor(
    Date.parse("2026-09-30T17:00:00Z") / 1000
  );

  it("is one event carrying a rule, not six bookings", async () => {
    // The founder gets ONE invitation. Six separate bookings would land six
    // emails at once, which was the objection that decided this design.
    const c = await cast();
    const { res, body } = await book(c, { repeatEveryWeeks: 4, repeatCount: 6 });

    expect(res.status).toBe(200);
    expect(cal.create).toHaveBeenCalledTimes(1);
    expect(cal.create.mock.calls[0]![0]).toMatchObject({
      recurrenceRule: "RRULE:FREQ=WEEKLY;INTERVAL=4;COUNT=6",
    });

    // Stored so the app can say "this cancels all six" before it does.
    const [row] = await harness.db.select().from(events);
    expect(row.recurrenceRule).toBe("RRULE:FREQ=WEEKLY;INTERVAL=4;COUNT=6");
    expect(body.event.id).toBe(row.id);
  });

  it("refuses when a LATER date is taken, and books nothing", async () => {
    // The point of checking ahead. The first date is on screen and free; the
    // second is a month away, and finding out then means an apology.
    const c = await cast();
    cal.busyDates.add(FOUR_WEEKS);

    const { res, body } = await book(c, { repeatEveryWeeks: 4, repeatCount: 3 });

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/2026-09-30/);
    // Nothing reached anyone's calendar — the refusal happens before the
    // provider is touched, so there is no invitation to withdraw.
    expect(cal.create).not.toHaveBeenCalled();
    expect(await harness.db.select().from(events)).toHaveLength(0);
  });

  it("stays a one-off when nobody asks for a repeat", async () => {
    const c = await cast();
    await book(c);
    expect(cal.create.mock.calls[0]![0]).toMatchObject({ recurrenceRule: undefined });
    const [row] = await harness.db.select().from(events);
    expect(row.recurrenceRule).toBeNull();
  });
});
