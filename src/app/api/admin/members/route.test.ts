import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createTestDb, reinstallTestDb, type TestDb } from "@/test/db";
import {
  adminCookie,
  jsonRequest,
  mockCookies,
  seedMember,
  seedConnection,
  seedEvent,
  OWNER_EMAIL,
} from "@/test/helpers";
import { members, events, eventAttendees, calendarConnections } from "@/db/schema";

/** Adding and removing people. The tier split matters here more than anywhere
 * else: removing someone is irreversible and marking someone Team is granting
 * admin, so both are owner-only while everything else stays open to staff. */

let harness: TestDb;

const revokeNylasGrant = vi.fn(async () => ({}));
vi.mock("@/lib/nylas", () => ({
  revokeNylasGrant: () => revokeNylasGrant(),
}));

/** Not on the ADMIN_EMAILS allowlist — admin comes from the Team flag alone. */
const TEAM_EMAIL = "karin.team@foundernexus.com";

beforeAll(async () => {
  harness = await createTestDb();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await harness.reset();
  vi.clearAllMocks();
  revokeNylasGrant.mockResolvedValue({});
  vi.resetModules();
  await reinstallTestDb();
});

/** A Team member has to exist as a row for resolveAdminTier to find the flag. */
async function asTeam() {
  await seedMember({ email: TEAM_EMAIL, isFacilitator: true });
  mockCookies(await adminCookie(TEAM_EMAIL));
  return adminCookie(TEAM_EMAIL);
}

async function asOwner() {
  mockCookies(await adminCookie(OWNER_EMAIL));
  return adminCookie(OWNER_EMAIL);
}

async function addPerson(cookie: string, payload: Record<string, unknown>) {
  const { POST } = await import("./route");
  return POST(jsonRequest("http://localhost/api/admin/members", payload, { cookie }));
}

async function removePerson(id: number) {
  const { DELETE } = await import("./[id]/route");
  return DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
    params: Promise.resolve({ id: String(id) }),
  });
}

describe("adding people", () => {
  it("lets Team add a founder", async () => {
    const cookie = await asTeam();
    const res = await addPerson(cookie, { fullName: "New Founder", email: "nf@example.com" });
    expect(res.status).toBe(200);
    expect(await harness.db.select().from(members)).toHaveLength(2);
  });

  it("lets Team add an advisor", async () => {
    const cookie = await asTeam();
    const res = await addPerson(cookie, {
      fullName: "New Advisor",
      email: "na@example.com",
      isAdvisor: true,
    });
    expect(res.status).toBe(200);
  });

  it("refuses to let Team create another Team member", async () => {
    const cookie = await asTeam();
    // Marking someone Team IS granting admin. Staff can grow the roster but
    // not the set of people who can remove from it.
    const res = await addPerson(cookie, {
      fullName: "Sneaky",
      email: "sneaky@example.com",
      isFacilitator: true,
    });
    expect(res.status).toBe(403);
    expect(await harness.db.select().from(members)).toHaveLength(1);
  });

  it("lets the owner create a Team member", async () => {
    const cookie = await asOwner();
    const res = await addPerson(cookie, {
      fullName: "Karin",
      email: "karin@foundernexus.com",
      isFacilitator: true,
    });
    expect(res.status).toBe(200);
  });

  it("rejects a duplicate address regardless of case", async () => {
    const cookie = await asOwner();
    await addPerson(cookie, { fullName: "A", email: "dup@example.com" });
    const res = await addPerson(cookie, { fullName: "B", email: "DUP@Example.com" });
    expect(res.status).toBe(409);
    expect(await harness.db.select().from(members)).toHaveLength(1);
  });
});

describe("removing people", () => {
  it("refuses Team entirely", async () => {
    const cookie = await asTeam();
    const victim = await seedMember({ email: "v@example.com" });
    mockCookies(cookie);

    const res = await removePerson(victim.id);

    expect(res.status).toBe(403);
    expect(await harness.db.select().from(members)).toHaveLength(2);
  });

  it("lets the owner remove someone, revoking the grant with them", async () => {
    await asOwner();
    const victim = await seedMember({ email: "v@example.com" });
    await seedConnection({ memberId: victim.id, grantEmail: victim.email, grantId: "g-v" });

    const res = await removePerson(victim.id);

    expect(res.status).toBe(200);
    // Deleting our row alone would leave Nylas holding a live token for that
    // calendar, still readable and still counting against the plan.
    expect(revokeNylasGrant).toHaveBeenCalledTimes(1);
    expect(await harness.db.select().from(calendarConnections)).toHaveLength(0);
  });

  it("refuses when they are in a confirmed session", async () => {
    await asOwner();
    const lead = await seedMember({ email: "lead@example.com", isFacilitator: true });
    const founder = await seedMember({ email: "f@example.com" });
    await seedEvent({
      organizerMemberId: lead.id,
      idempotencyKey: "k-confirmed",
      startsAt: new Date("2026-09-02T17:00:00Z"),
      attendees: [{ memberId: founder.id, email: founder.email }],
    });

    const res = await removePerson(founder.id);

    expect(res.status).toBe(409);
    expect(revokeNylasGrant).not.toHaveBeenCalled();
  });

  it("allows removal when only cancelled sessions remain, clearing them up", async () => {
    await asOwner();
    const lead = await seedMember({ email: "lead@example.com", isFacilitator: true });
    const founder = await seedMember({ email: "f@example.com" });
    await seedEvent({
      organizerMemberId: lead.id,
      idempotencyKey: "k-cancelled",
      startsAt: new Date("2026-09-02T17:00:00Z"),
      status: "cancelled",
      attendees: [{ memberId: founder.id, email: founder.email }],
    });

    // A cancelled session never happened. Counting it blocked removal while
    // the grid — which only renders confirmed sessions — showed nothing, so
    // the admin was told about rows they had no way to find.
    const res = await removePerson(founder.id);

    expect(res.status).toBe(200);
    expect(await harness.db.select().from(eventAttendees)).toHaveLength(0);
    // Somebody else led it, so the cancellation itself survives for them.
    expect(await harness.db.select().from(events)).toHaveLength(1);
  });

  it("deletes cancelled sessions the removed person led", async () => {
    await asOwner();
    const lead = await seedMember({ email: "lead@example.com", isFacilitator: true });
    await seedEvent({
      organizerMemberId: lead.id,
      idempotencyKey: "k-theirs",
      startsAt: new Date("2026-09-02T17:00:00Z"),
      status: "cancelled",
    });

    const res = await removePerson(lead.id);

    expect(res.status).toBe(200);
    // An event with no organiser is not a record of anything.
    expect(await harness.db.select().from(events)).toHaveLength(0);
  });

  it("refuses to remove an allowlisted admin", async () => {
    await asOwner();
    const owner = await seedMember({ email: OWNER_EMAIL });
    // Their row is what /api/connect/start verifies against; deleting it
    // locks them out while the env var still calls them an admin.
    const res = await removePerson(owner.id);
    expect(res.status).toBe(409);
  });

  it("still removes the member when the grant cannot be revoked", async () => {
    await asOwner();
    const victim = await seedMember({ email: "v@example.com" });
    await seedConnection({ memberId: victim.id, grantEmail: victim.email, grantId: "g-v" });
    revokeNylasGrant.mockRejectedValue(new Error("nylas down"));

    const res = await removePerson(victim.id);

    // A Nylas hiccup must not make somebody permanently undeletable — but the
    // caller is told, so the leftover can be cleared by hand.
    expect(res.status).toBe(200);
    expect((await res.json()).grantRevokeFailed).toBe(true);
    expect(await harness.db.select().from(members)).toHaveLength(0);
  });
});

describe("auth", () => {
  it("rejects both endpoints without a session", async () => {
    mockCookies();
    const victim = await seedMember({ email: "v@example.com" });
    expect((await addPerson("", { fullName: "x", email: "x@y.z" })).status).toBe(401);
    expect((await removePerson(victim.id)).status).toBe(401);
  });
});
