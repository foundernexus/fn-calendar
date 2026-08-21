import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createTestDb, reinstallTestDb, type TestDb } from "@/test/db";
import { adminCookie, jsonRequest, mockCookies, seedMember, OWNER_EMAIL } from "@/test/helpers";

/** Editing and removing a person — the two actions on the People page that
 * change who exists. Both were untested; removal is the only irreversible
 * thing an admin can do, and editing is new. */

let harness: TestDb;

beforeAll(async () => {
  harness = await createTestDb();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await harness.reset();
  vi.resetModules();
  mockCookies(await adminCookie());
  await reinstallTestDb();
});

async function patch(id: number, body: unknown, cookie?: string) {
  const c = cookie ?? (await adminCookie());
  const { PATCH } = await import("./route");
  const res = await PATCH(jsonRequest("http://localhost", body, { cookie: c, method: "PATCH" }), {
    params: Promise.resolve({ id: String(id) }),
  });
  return { res, body: await res.json() };
}

/** An admin whose access comes from the Team flag rather than ADMIN_EMAILS. */
async function teamCookie() {
  const staff = await seedMember({ email: "karin@foundernexus.com", isFacilitator: true });
  return { staff, cookie: await adminCookie(staff.email) };
}

describe("editing a person", () => {
  it("renames them, and the People list shows the new name", async () => {
    const person = await seedMember({ email: "t@foundernexus.com", fullName: "tobias" });

    const { res } = await patch(person.id, { fullName: "Tobias Hock" });
    expect(res.status).toBe(200);

    // The second half: the write is only worth anything if the page an admin
    // looks at next reflects it.
    const { getMembersWithConnectionStatus } = await import("@/db/queries");
    const listed = (await getMembersWithConnectionStatus()).find((m) => m.id === person.id);
    expect(listed!.fullName).toBe("Tobias Hock");
  });

  it("leaves the email alone", async () => {
    // The address is the join between this row and their calendar, their
    // sign-in, and their invitations. Editing it here would strand a connected
    // account against an address that no longer exists on any member.
    const person = await seedMember({ email: "t@foundernexus.com", fullName: "tobias" });

    await patch(person.id, { fullName: "Tobias", email: "someone-else@foundernexus.com" });

    const { getMemberById } = await import("@/db/queries");
    expect((await getMemberById(person.id))!.email).toBe("t@foundernexus.com");
  });

  it("moves someone between founder and advisor", async () => {
    const person = await seedMember({ email: "a@foundernexus.com", fullName: "Court" });

    await patch(person.id, { fullName: "Court", isAdvisor: true, isFacilitator: false });

    const { getMemberById } = await import("@/db/queries");
    expect((await getMemberById(person.id))!.isAdvisor).toBe(true);
  });

  it("refuses a Team promotion from anyone but an owner", async () => {
    // Team IS admin (see hasAdminAccess), so granting it is granting access.
    // Same rule as adding a Team member, enforced in the same place.
    const { cookie } = await teamCookie();
    const person = await seedMember({ email: "b@foundernexus.com", fullName: "Someone" });

    // requireAdminSession reads next/headers, not the Request — swapping who is
    // signed in means re-mocking the cookie store, not just passing a header.
    vi.resetModules();
    mockCookies(cookie);
    await reinstallTestDb();

    const { res, body } = await patch(
      person.id,
      { fullName: "Someone", isFacilitator: true },
      cookie
    );

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/owner/i);

    const { getMemberById } = await import("@/db/queries");
    expect((await getMemberById(person.id))!.isFacilitator).toBe(false);
  });

  it("lets a Team admin rename someone who is already Team", async () => {
    // The check is on the CHANGE, not on the value. Refusing a rename because
    // the flag happens to be set would block ordinary tidying up.
    const { cookie, staff } = await teamCookie();

    vi.resetModules();
    mockCookies(cookie);
    await reinstallTestDb();

    const { res } = await patch(staff.id, { fullName: "Karin B.", isFacilitator: true }, cookie);
    expect(res.status).toBe(200);
  });

  it("rejects an empty name", async () => {
    const person = await seedMember({ email: "c@foundernexus.com", fullName: "Real Name" });
    const { res } = await patch(person.id, { fullName: "   " });
    expect(res.status).toBe(400);
  });

  it("404s for someone who no longer exists", async () => {
    const { res } = await patch(9999, { fullName: "Ghost" });
    expect(res.status).toBe(404);
  });

  it("rejects an unauthenticated request", async () => {
    vi.resetModules();
    mockCookies();
    await reinstallTestDb();
    const person = await seedMember({ email: "d@foundernexus.com", fullName: "X" });
    const { PATCH } = await import("./route");
    const res = await PATCH(jsonRequest("http://localhost", { fullName: "Y" }, { method: "PATCH" }), {
      params: Promise.resolve({ id: String(person.id) }),
    });
    expect(res.status).toBe(401);
  });
});

describe("removing a person", () => {
  async function remove(id: number, cookie?: string) {
    const c = cookie ?? (await adminCookie());
    const { DELETE } = await import("./route");
    const res = await DELETE(new Request("http://localhost", { headers: { cookie: c } }), {
      params: Promise.resolve({ id: String(id) }),
    });
    return { res, body: await res.json() };
  }

  it("refuses anyone but an owner", async () => {
    const { cookie } = await teamCookie();
    const person = await seedMember({ email: "e@foundernexus.com", fullName: "Someone" });

    vi.resetModules();
    mockCookies(cookie);
    await reinstallTestDb();
    const { res } = await remove(person.id, cookie);

    expect(res.status).toBe(403);
    const { getMemberById } = await import("@/db/queries");
    expect(await getMemberById(person.id)).toBeTruthy();
  });

  it("refuses to remove an ADMIN_EMAILS account", async () => {
    // The allowlist outlives the row. Deleting it leaves someone who is still
    // an admin but has no member row to verify a calendar against, and their
    // sign-in then fails with a message that explains nothing.
    const owner = await seedMember({ email: OWNER_EMAIL, fullName: "Owner" });
    const { res, body } = await remove(owner.id);
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/ADMIN_EMAILS/);
  });

  it("treats an already-deleted person as success", async () => {
    // A double click or a stale page shouldn't produce an alarming error about
    // the state the admin was asking for anyway.
    const { res, body } = await remove(9999);
    expect(res.status).toBe(200);
    expect(body.alreadyRemoved).toBe(true);
  });
});
