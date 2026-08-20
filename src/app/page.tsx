import { redirect } from "next/navigation";
import { requireMemberSession } from "@/lib/auth/member";
import { requireAdminSession } from "@/lib/auth/admin";

// Reads live session cookies (to route a returning, already-logged-in
// visitor straight to their dashboard) and must never be statically cached —
// same reasoning as /connect.
export const dynamic = "force-dynamic";

/** Sends everyone straight where they belong. Nothing renders here.
 *
 * This used to be a landing page describing the tool, with Sign in and Privacy
 * policy buttons. Nobody arriving here needs to be sold it: every visitor is
 * either already signed in, or holding a link an admin sent them and expecting
 * a sign-in form. A page whose only purpose is a button to the next page is a
 * step to click through, so the first thing anyone sees is now the form itself.
 *
 * The privacy policy is still linked from /connect, which is where Google's
 * reviewer looks for it — and where someone about to grant calendar access
 * would actually think to check. */
export default async function Home() {
  const adminSession = await requireAdminSession();
  if (adminSession) redirect("/admin/find-a-time");

  const memberSession = await requireMemberSession();
  if (memberSession) redirect("/me");

  redirect("/connect");
}
