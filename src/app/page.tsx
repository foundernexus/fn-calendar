import Link from "next/link";
import { redirect } from "next/navigation";
import { requireMemberSession } from "@/lib/auth/member";
import { requireAdminSession } from "@/lib/auth/admin";
import { buttonVariants } from "@/components/ui/button";

// Reads live session cookies (to route a returning, already-logged-in
// visitor straight to their dashboard) and must never be statically cached —
// same reasoning as /connect.
export const dynamic = "force-dynamic";

export default async function Home() {
  const adminSession = await requireAdminSession();
  if (adminSession) redirect("/admin/find-a-time");
  const memberSession = await requireMemberSession();
  if (memberSession) redirect("/me");

  return (
    <div className="mx-auto max-w-2xl py-16">
      <h1 className="text-2xl font-bold text-foreground">FounderNexus Scheduler</h1>
      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
        FounderNexus Scheduler is our internal tool for scheduling expert sessions.
        Members connect their calendar so we can see everyone&apos;s real availability
        and find a shared time in a few clicks — no more email back-and-forth to
        find a slot that works.
      </p>
      <div className="mt-8 flex gap-3">
        <Link href="/connect" className={buttonVariants({ size: "lg" })}>
          Sign in
        </Link>
        <Link href="/privacy" className={buttonVariants({ variant: "outline", size: "lg" })}>
          Privacy policy
        </Link>
      </div>
    </div>
  );
}
