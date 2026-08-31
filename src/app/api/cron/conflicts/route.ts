import { NextResponse } from "next/server";
import { detectSeriesConflicts } from "@/lib/conflicts";
import { syncOneToOneToHubspot } from "@/lib/one-to-one";
import { refreshAttendance } from "@/lib/attendance";
import { env } from "@/lib/env";

// Reads calendars over the network for every upcoming date of every series.
// Never prerendered, and given room to finish.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** The daily look-ahead over repeating sessions.
 *
 * Called by Vercel Cron (see vercel.json). Vercel sends `Authorization: Bearer
 * $CRON_SECRET` when that variable is set on the project.
 *
 * Refuses to run when CRON_SECRET is missing rather than defaulting to open.
 * This endpoint reads every participant's calendar, so an open version is a
 * button any stranger can hold down to burn the Google quota the whole app
 * depends on. Failing closed costs a silent no-op until somebody sets the
 * variable; failing open costs the availability search. */
export async function GET(request: Request) {
  const secret = env.CRON_SECRET;
  if (!secret) {
    console.error("[cron/conflicts] CRON_SECRET is not set — refusing to run");
    return NextResponse.json({ error: "Not configured." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    console.warn("[cron/conflicts] rejected a request with no or wrong bearer token");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const conflicts = await detectSeriesConflicts();
    console.info("[cron] conflict check finished", conflicts);

    // Runs even if the conflict check found nothing — they are independent
    // jobs sharing one schedule, and a quiet night for one is not a reason to
    // skip the other.
    const hubspot = await syncOneToOneToHubspot();
    console.info("[cron] hubspot 1:1 sync finished", hubspot);

    // Last, and behind its own catch, which is the point rather than caution.
    // The two jobs above have already done their work by the time this starts;
    // letting a failure here escape into the handler's catch would turn a run
    // that succeeded into a 500 and hide that they succeeded. Reading RSVPs is
    // also the newest and least important of the three — it is the one that
    // should give way, not the one that takes the others down with it.
    let attendance;
    try {
      attendance = await refreshAttendance();
      console.info("[cron] attendance refresh finished", attendance);
    } catch (err) {
      console.error("[cron/conflicts] attendance refresh failed", err);
      attendance = { error: err instanceof Error ? err.message : "failed" };
    }

    return NextResponse.json({ ok: true, conflicts, hubspot, attendance });
  } catch (err) {
    // Loud, because nothing else will notice. Nobody is looking at this route,
    // and a check that quietly stopped running would leave the list looking
    // reassuringly empty while clashes piled up behind it.
    console.error("[cron/conflicts] failed", err);
    return NextResponse.json({ error: "Conflict check failed." }, { status: 500 });
  }
}
