import { getMemberByEmail, getActiveConnections } from "@/db/queries";
import { ConnectForm } from "@/components/connect-form";

// Reads live connection state and must never be statically cached — currently
// only dynamic as a side effect of reading searchParams before the DB call;
// making it explicit means it stays correct even if that ordering changes.
export const dynamic = "force-dynamic";

export default async function ConnectPage({ searchParams }: PageProps<"/connect">) {
  const params = await searchParams;
  const email = typeof params.email === "string" ? params.email : undefined;
  const hadError = params.status === "error";

  let initialStatus: "connected" | "not_connected" = "not_connected";
  let initialProvider: string | undefined;
  let initialGrantEmail: string | undefined;

  if (email) {
    const member = await getMemberByEmail(email);
    if (member) {
      const active = await getActiveConnections([member.id]);
      if (active.length > 0) {
        initialStatus = "connected";
        initialProvider = active[0].provider;
        // The actually-connected calendar account can differ from the
        // registered email (e.g. a personal Gmail) — show it explicitly so a
        // member can tell if they connected the wrong account.
        initialGrantEmail = active[0].grant_email;
      }
    }
  }

  return (
    <div className="mx-auto max-w-md py-16">
      <h1 className="text-2xl font-bold text-foreground">Connect your calendar</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Enter your email to connect your calendar (Google, Microsoft, or iCloud) so
        an admin can find a time that works for your next expert session.
      </p>
      {hadError && (
        <p className="mt-6 rounded-md border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          That connection attempt didn&apos;t go through — the link may have expired.
          Please try again.
        </p>
      )}
      <div className="mt-8">
        <ConnectForm
          initialEmail={email}
          initialStatus={initialStatus}
          initialProvider={initialProvider}
          initialGrantEmail={initialGrantEmail}
        />
      </div>
    </div>
  );
}
