"use client";

import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MemberWithConnection } from "@/db/queries";

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  microsoft: "Microsoft",
  icloud: "iCloud",
};

/** The three states an admin actually needs to tell apart, in the order they
 * need attention. `pending` is the whole reason this page exists: until now a
 * member who was added but never connected appeared in no picker, no search
 * and no list — invisible everywhere, with nothing to remind anyone they were
 * still waiting on an invite. */
type Status = "pending" | "reconnect" | "connected";

function statusOf(m: MemberWithConnection): Status {
  if (m.connected) return "connected";
  if (m.needsReconnect) return "reconnect";
  return "pending";
}

const STATUS_ORDER: Record<Status, number> = { pending: 0, reconnect: 1, connected: 2 };

export function MemberDirectory({
  members,
  connectUrl,
}: {
  members: MemberWithConnection[];
  connectUrl: string;
}) {
  const sorted = [...members].sort(
    (a, b) =>
      STATUS_ORDER[statusOf(a)] - STATUS_ORDER[statusOf(b)] ||
      a.fullName.localeCompare(b.fullName)
  );

  const counts = {
    pending: members.filter((m) => statusOf(m) === "pending").length,
    reconnect: members.filter((m) => statusOf(m) === "reconnect").length,
    connected: members.filter((m) => statusOf(m) === "connected").length,
  };

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(connectUrl);
      toast.success("Sign-in link copied.");
    } catch {
      toast.error("Couldn't copy — copy it manually instead.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-border bg-card p-4 shadow-card">
          <p className="text-2xl font-bold text-foreground">{counts.connected}</p>
          <p className="mt-1 text-xs text-muted-foreground">Connected</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 shadow-card">
          <p
            className={
              counts.pending > 0
                ? "text-2xl font-bold text-destructive"
                : "text-2xl font-bold text-foreground"
            }
          >
            {counts.pending}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Waiting to connect</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 shadow-card">
          <p
            className={
              counts.reconnect > 0
                ? "text-2xl font-bold text-destructive"
                : "text-2xl font-bold text-foreground"
            }
          >
            {counts.reconnect}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Need to reconnect</p>
        </div>
      </div>

      {counts.pending > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/50 p-4">
          <p className="text-sm text-foreground">
            {counts.pending === 1
              ? "1 person was added but hasn't connected a calendar yet."
              : `${counts.pending} people were added but haven't connected a calendar yet.`}{" "}
            <span className="text-muted-foreground">
              They can&apos;t be picked for a session until they do.
            </span>
          </p>
          <Button type="button" variant="secondary" size="sm" onClick={copyLink}>
            Copy sign-in link
          </Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Calendar</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((m) => {
              const status = statusOf(m);
              return (
                <TableRow key={m.id}>
                  <TableCell className="font-medium text-foreground">{m.fullName}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {m.email}
                    {/* Only worth showing when it differs — a member may sign in
                        with a personal calendar that isn't their registered
                        address, and invites go to whichever one is shown here. */}
                    {m.grantEmail && m.grantEmail !== m.email && (
                      <span className="block text-xs">connected as {m.grantEmail}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {m.isFacilitator && <Badge variant="outline">Facilitator</Badge>}
                      {m.isAdvisor && <Badge variant="outline">Advisor</Badge>}
                      {!m.isFacilitator && !m.isAdvisor && (
                        <span className="text-sm text-muted-foreground">Guest</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {status === "connected" ? (
                      <Badge variant="secondary">
                        {m.provider ? (PROVIDER_LABELS[m.provider] ?? m.provider) : "Connected"}
                      </Badge>
                    ) : status === "reconnect" ? (
                      <Badge variant="destructive">Needs reconnect</Badge>
                    ) : (
                      <Badge variant="destructive">Waiting</Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
