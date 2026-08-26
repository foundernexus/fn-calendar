import { env } from "@/lib/env";
import { normalizeEmail } from "@/lib/email";

/** Writing a member's 1:1 rhythm back to HubSpot.
 *
 * One direction only, and that is a decision rather than a shortcut. Two-way
 * sync means two systems can write the same field, which is how they start
 * disagreeing and how nobody can later say which value was right. "When is the
 * next 1:1" is a fact this tool owns — it created the meeting — so it is the
 * only writer, and HubSpot is the only reader.
 *
 * Nothing here ever creates a contact. HubSpot owns the person; a scheduler
 * that invents people produces duplicates for somebody else to clean up. An
 * address with no contact behind it is logged and skipped.
 *
 * Every function here is best-effort. A booking that succeeded must never be
 * reported as failed because a note about it didn't land — see the callers. */

const API = "https://api.hubapi.com";

/** What the tool is allowed to write, and nothing else.
 *
 * `fn_11_cadence` is deliberately absent. "Paused" is a decision a person made
 * about a relationship, not something readable from a calendar, and a nightly
 * job overwriting it would quietly destroy an answer Karin gave on purpose. */
/** A moment, carried in both the forms HubSpot might want it in.
 *
 * Which one is correct depends on how the property is typed over there, and
 * that is not something this app controls — somebody switching "FN Next Monthly
 * 1:1" from Date to Date-and-time in the HubSpot UI is a reasonable thing to do
 * and silently changes the right answer. Sending both and choosing at write
 * time is what stops that being a bug.
 *
 * `localDate` is the calendar date in the SESSION's timezone, which is not
 * always the UTC one: a 17:00 Pacific session is already tomorrow in UTC. */
export type DateValue = { iso: string; localDate: string };

export type OneToOneFields = {
  /** Next 1:1. Null clears it — nothing upcoming. */
  fn_next_monthly_11: DateValue | null;
  /** Most recent 1:1 that has already happened. */
  fn_last_monthly_11: DateValue | null;
  /** How far ahead the series reaches. Null for a one-off. */
  fn_11_booked_through: DateValue | null;
  /** The address they connected their calendar under, which is often NOT the
   * address HubSpot knows them by. Written so that gap becomes visible instead
   * of staying a silent reason things don't match up. */
  fn_calendar_email: string | null;
};

export function hubspotConfigured() {
  return env.HUBSPOT_TOKEN.length > 0;
}

async function hubspotFetch(path: string, init: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${env.HUBSPOT_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    // The body carries the reason — a wrong scope reads very differently from a
    // property that doesn't exist, and the status alone says neither.
    const body = await res.text().catch(() => "");
    throw new Error(`HubSpot ${path} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res;
}

/** Finds the contact for a member, trying every address we hold for them.
 *
 * Two addresses, because they routinely differ: the tool invites whichever
 * calendar account somebody connected, while HubSpot knows them by the address
 * they registered under. Searching only one of the two is why a meeting can
 * exist in HubSpot and still not be attached to the right person.
 *
 * Returns null when nothing matches, which is a normal outcome — not everyone
 * in the scheduler is in the CRM. */
export type HubspotContact = {
  id: string;
  /** The 1:1 fields as they currently stand, so a caller can tell whether a
   * write would actually change anything. */
  properties: Record<string, string | null>;
};

export async function findContact(
  emails: (string | null | undefined)[]
): Promise<HubspotContact | null> {
  const candidates = [...new Set(emails.filter(Boolean).map((e) => normalizeEmail(e!)))];
  if (candidates.length === 0) return null;

  const res = await hubspotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      // One request for both addresses. `IN` on email is an exact match, which
      // is what we want — a fuzzy match on somebody's email would attach a
      // meeting to the wrong person, and that is worse than not attaching it.
      filterGroups: [{ filters: [{ propertyName: "email", operator: "IN", values: candidates }] }],
      // The current values come back with the lookup rather than in a second
      // request, so the reconcile can skip contacts that already read correctly
      // instead of rewriting the whole roster every night.
      properties: ["email", "fn_next_monthly_11", "fn_last_monthly_11", "fn_11_booked_through"],
      limit: 1,
    }),
  });
  const data = (await res.json()) as {
    results?: { id: string; properties?: Record<string, string | null> }[];
  };
  const hit = data.results?.[0];
  return hit ? { id: hit.id, properties: hit.properties ?? {} } : null;
}

/** How each property is typed over in HubSpot, cached for the life of the
 * process.
 *
 * Module scope is deliberate here, unlike the per-request maps elsewhere in
 * this codebase: this is configuration about the CRM, identical for every
 * request, not data about the member being handled. A short life means somebody
 * changing a property's type is picked up on the next deploy or cold start
 * rather than needing one.
 *
 * Failing to read the types is not failing to write. An unknown type falls back
 * to the readable form, which is what the code sent before it asked at all. */
const typeCache = new Map<string, string>();
let typeCacheFilledAt = 0;
const TYPE_CACHE_MS = 10 * 60 * 1000;

async function propertyTypes(names: string[]): Promise<Map<string, string>> {
  const fresh = Date.now() - typeCacheFilledAt < TYPE_CACHE_MS;
  if (fresh && names.every((n) => typeCache.has(n))) return typeCache;

  try {
    const res = await hubspotFetch("/crm/v3/properties/contacts/batch/read", {
      method: "POST",
      body: JSON.stringify({ inputs: names.map((name) => ({ name })) }),
    });
    const data = (await res.json()) as { results?: { name: string; type: string }[] };
    for (const p of data.results ?? []) typeCache.set(p.name, p.type);
    typeCacheFilledAt = Date.now();
  } catch (err) {
    console.warn("[hubspot] couldn't read property types, using date form:", err);
  }
  return typeCache;
}

/** Writes a member's 1:1 state onto their contact. */
export async function updateContact(contactId: string, fields: Partial<OneToOneFields>) {
  // Empty string, not null. This is the whole reason a cancelled 1:1 kept its
  // date: HubSpot ignores a JSON null on write, answers 200 as if it had done
  // the work, and leaves the old value standing. An empty string is how the v3
  // API clears a property. Nothing else about the request differs, which is why
  // rescheduling always worked and only cancelling didn't.
  //
  // The format is chosen from the property's own type rather than assumed. A
  // date-only string sent to a Date-and-time property is read as midnight UTC,
  // which in Pacific is five o'clock the PREVIOUS afternoon — a booking on the
  // 31st showing as the 30th, with no error anywhere to suggest it.
  const types = await propertyTypes(Object.keys(fields));
  const properties = Object.fromEntries(
    Object.entries(fields).map(([name, value]) => {
      if (value === null || value === undefined) return [name, ""];
      if (typeof value === "string") return [name, value];
      // A property typed as plain text gets the readable form; nobody wants a
      // full ISO timestamp sitting in a text column.
      return [name, types.get(name) === "datetime" ? value.iso : value.localDate];
    })
  );
  await hubspotFetch(`/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

/** The whole write for one member, resolved and applied.
 *
 * Swallows its own failure on purpose. Callers run this alongside a booking
 * that has already happened, and a CRM note that didn't land is not a reason to
 * tell somebody their session failed. The nightly reconcile picks up whatever
 * was missed. */
export async function syncOneToOne(params: {
  emails: (string | null | undefined)[];
  fields: Partial<OneToOneFields>;
  context: string;
}): Promise<"written" | "no-contact" | "skipped" | "failed"> {
  if (!hubspotConfigured()) return "skipped";
  try {
    const contact = await findContact(params.emails);
    if (!contact) {
      console.info(`[hubspot] no contact for ${params.emails.filter(Boolean).join(", ")}`);
      return "no-contact";
    }
    await updateContact(contact.id, params.fields);
    return "written";
  } catch (err) {
    console.warn(`[hubspot] ${params.context} sync failed:`, err);
    return "failed";
  }
}
