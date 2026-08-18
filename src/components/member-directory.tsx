"use client";

import { Fragment } from "react";
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

/** The three states an admin needs to tell apart, ordered by how much they
 * need doing something about. `pending` is the whole reason this page exists:
 * a member who was added but never connected appeared in no picker, no search
 * and no list — invisible everywhere, with nothing to remind anyone they were
 * still waiting on an invite. */
type Status = "reconnect" | "pending" | "connected";

/** Groups within a status section. "founder" is the default: everyone who
 * isn't FounderNexus staff or a named advisor is a founder being scheduled.
 *
 * Advisor deliberately wins over facilitator when someone carries both flags.
 * That combination means FN staff also sitting in advisor sessions, and the
 * advisor role is the one worth tracking — it's the smaller list, it gates its
 * own picker, and it's what an admin scans this page looking for. */
type Role = "advisor" | "team" | "founder";

function statusOf(m: MemberWithConnection): Status {
  if (m.connected) return "connected";
  if (m.needsReconnect) return "reconnect";
  return "pending";
}

function roleOf(m: MemberWithConnection): Role {
  if (m.isAdvisor) return "advisor";
  if (m.isFacilitator) return "team";
  return "founder";
}

const ROLE_ORDER: Role[] = ["advisor", "team", "founder"];
const ROLE_LABELS: Record<Role, { one: string; many: string }> = {
  advisor: { one: "Advisor", many: "Advisors" },
  team: { one: "Team", many: "Team" },
  founder: { one: "Founder", many: "Founders" },
};

const SECTIONS: {
  status: Status;
  title: string;
  hint: string;
  urgent: boolean;
}[] = [
  {
    status: "reconnect",
    title: "Need to reconnect",
    hint: "Connected under an older setup — their calendar can't be read until they sign in again.",
    urgent: true,
  },
  {
    status: "pending",
    title: "Waiting to connect",
    hint: "Added, but they haven't connected a calendar yet — they can't be picked for a session until they do.",
    urgent: true,
  },
  {
    status: "connected",
    title: "Connected",
    hint: "Ready to be scheduled.",
    urgent: false,
  },
];

export function MemberDirectory({
  members,
  connectUrl,
}: {
  members: MemberWithConnection[];
  connectUrl: string;
}) {
  const counts = {
    connected: members.filter((m) => statusOf(m) === "connected").length,
    pending: members.filter((m) => statusOf(m) === "pending").length,
    reconnect: members.filter((m) => statusOf(m) === "reconnect").length,
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
    <div className="space-y-8">
      <div className="grid grid-cols-3 gap-4">
        <SummaryCard label="Connected" value={counts.connected} />
        <SummaryCard label="Waiting to connect" value={counts.pending} urgent />
        <SummaryCard label="Need to reconnect" value={counts.reconnect} urgent />
      </div>

      {members.length === 0 && (
        <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground shadow-card">
          No one&apos;s been added yet.
        </p>
      )}

      {SECTIONS.map((section) => {
        const inSection = members.filter((m) => statusOf(m) === section.status);
        // Empty sections are dropped rather than shown as "0". A page listing
        // "Need to reconnect: none" on every visit trains you to stop reading
        // the headings, which is exactly what this page needs you to do.
        if (inSection.length === 0) return null;

        return (
          <section key={section.status}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                  {section.title}
                  <span
                    className={
                      section.urgent
                        ? "rounded-4xl bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
                        : "rounded-4xl bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground"
                    }
                  >
                    {inSection.length}
                  </span>
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{section.hint}</p>
              </div>
              {section.status === "pending" && (
                <Button type="button" variant="secondary" size="sm" onClick={copyLink}>
                  Copy sign-in link
                </Button>
              )}
            </div>

            <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-card shadow-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Calendar</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ROLE_ORDER.map((role) => {
                    const inGroup = inSection.filter((m) => roleOf(m) === role);
                    if (inGroup.length === 0) return null;
                    const label = ROLE_LABELS[role];

                    return (
                      <Fragment key={role}>
                        <TableRow className="hover:bg-transparent">
                          <TableCell
                            colSpan={3}
                            className="bg-secondary/40 py-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase"
                          >
                            {inGroup.length === 1 ? label.one : label.many} · {inGroup.length}
                          </TableCell>
                        </TableRow>
                        {[...inGroup]
                          .sort((a, b) => a.fullName.localeCompare(b.fullName))
                          .map((m) => (
                            <TableRow key={m.id}>
                              <TableCell className="font-medium text-foreground">
                                {m.fullName}
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {m.email}
                                {/* Only shown when it differs — a member can sign
                                    in with a personal calendar that isn't their
                                    registered address, and their invites go to
                                    whichever one is named here. */}
                                {m.grantEmail && m.grantEmail !== m.email && (
                                  <span className="block text-xs">
                                    invites go to {m.grantEmail}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                {m.connected ? (
                                  <Badge variant="secondary">
                                    {m.provider
                                      ? (PROVIDER_LABELS[m.provider] ?? m.provider)
                                      : "Connected"}
                                  </Badge>
                                ) : m.needsReconnect ? (
                                  <Badge variant="destructive">Needs reconnect</Badge>
                                ) : (
                                  <Badge variant="destructive">Waiting</Badge>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  urgent = false,
}: {
  label: string;
  value: number;
  urgent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-card">
      <p
        className={
          urgent && value > 0
            ? "text-2xl font-bold text-destructive"
            : "text-2xl font-bold text-foreground"
        }
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
