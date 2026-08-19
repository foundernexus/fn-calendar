"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Clock, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ProviderIcon } from "@/components/provider-icon";
import type { MemberWithConnection } from "@/db/queries";

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

// Team, then advisors, then founders. Founders is by far the longest list, so
// putting it last means the two short groups are always visible without
// scrolling past it — and it reads as FounderNexus outward, which is how
// people describe the org anyway.
const ROLE_ORDER: Role[] = ["team", "advisor", "founder"];
const ROLE_LABELS: Record<Role, { one: string; many: string }> = {
  advisor: { one: "Advisor", many: "Advisors" },
  team: { one: "Team", many: "Team" },
  founder: { one: "Founder", many: "Founders" },
};

const SECTIONS: { status: Status; title: string; hint: string; urgent: boolean }[] = [
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
  canRemove,
}: {
  members: MemberWithConnection[];
  connectUrl: string;
  /** Owner-only. Team members get the same view but no Remove — see
   * resolveAdminTier for why those two actions are the line. */
  canRemove: boolean;
}) {
  const router = useRouter();
  const [removing, setRemoving] = useState<MemberWithConnection | null>(null);

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
    <div className="space-y-10">
      {/* Adding lives in the page header, not here — one button for the page
          rather than one per table. The tables are per status AND role, so a
          per-table button would appear twice for the same role (once under
          Connected, once under Waiting), and a role nobody holds yet has no
          table at all, so "Add advisor" would go missing exactly when it was
          needed. The role is picked in the dialog instead. */}
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

            {/* One table per role rather than one table with group rows in it:
                the roles are separate lists an admin reads separately ("which
                advisors am I waiting on"), and giving each its own card makes
                that boundary something you see instead of something you parse. */}
            <div className="mt-4 space-y-5">
              {ROLE_ORDER.map((role) => {
                const inGroup = inSection.filter((m) => roleOf(m) === role);
                if (inGroup.length === 0) return null;
                const label = ROLE_LABELS[role];

                return (
                  <div key={role}>
                    <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      {inGroup.length === 1 ? label.one : label.many}
                      <span className="ml-1.5 normal-case opacity-60">{inGroup.length}</span>
                    </p>
                    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
                      {/* table-fixed with explicit widths, so the columns land
                          in the same place in all three tables. Left to size
                          themselves, each table measures its own longest name
                          and Email starts at a different x in every one — which
                          reads as three unrelated lists rather than one roster
                          split into groups. min-w keeps them scrolling rather
                          than crushing on a narrow screen. */}
                      <Table className="min-w-[40rem] table-fixed">
                        <TableHeader>
                          {/* Tinted so the header reads as a header. Against an
                              all-white card the column names sat at the same
                              visual weight as the rows, which is what made
                              three stacked tables hard to scan. */}
                          <TableRow className="bg-secondary/50 hover:bg-secondary/50">
                            <TableHead className="w-[15rem]">Name</TableHead>
                            <TableHead>Email</TableHead>
                            <TableHead className="w-[6rem] text-center">Calendar</TableHead>
                            <TableHead className="w-[3.5rem]" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {[...inGroup]
                            .sort((a, b) => a.fullName.localeCompare(b.fullName))
                            .map((m) => (
                              <TableRow key={m.id}>
                                <TableCell className="font-medium text-foreground">
                                  {/* Fixed columns mean long values have to be
                                      clipped rather than pushing the layout
                                      around; the title keeps the full value
                                      reachable on hover. */}
                                  <div className="truncate" title={m.fullName}>
                                    {m.fullName}
                                  </div>
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                  <div className="truncate" title={m.email}>
                                    {m.email}
                                  </div>
                                  {/* Only shown when it differs — a member can
                                      sign in with a personal calendar that isn't
                                      their registered address, and their invites
                                      go to whichever one is named here. */}
                                  {m.grantEmail && m.grantEmail !== m.email && (
                                    <div className="truncate text-xs" title={m.grantEmail}>
                                      invites go to {m.grantEmail}
                                    </div>
                                  )}
                                </TableCell>
                                <TableCell>
                                  {/* No status word here: the section heading
                                      above already says which state every row in
                                      this table is in, so repeating it per row
                                      would be noise. What the heading can't
                                      carry is WHICH calendar — that's the mark. */}
                                  <div className="flex justify-center">
                                    <StatusMark member={m} />
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    title={`Remove ${m.fullName}`}
                                    onClick={() => setRemoving(m)}
                                  >
                                    <Trash2 className="text-muted-foreground" />
                                    <span className="sr-only">Remove {m.fullName}</span>
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {removing && (
        <RemoveMemberDialog
          member={removing}
          onOpenChange={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

/** Connected members get their provider's mark; the two problem states get an
 * icon with a title, since "waiting for a first connection" and "connected but
 * needs redoing" are different problems with different fixes and must not
 * collapse into one generic warning glyph. */
function StatusMark({ member }: { member: MemberWithConnection }) {
  if (member.connected && member.connections.length > 0) {
    // One mark per connected calendar — a member can hold several, and all of
    // them are checked before a slot is offered. The invite target is the one
    // named in the Email column, so it isn't singled out again here.
    return (
      <span className="flex items-center gap-1">
        {member.connections.map((c) => (
          <ProviderIcon key={c.grantEmail} provider={c.provider} />
        ))}
      </span>
    );
  }
  // The label lives on a wrapping span rather than as an SVG <title> child:
  // that gives both the hover tooltip and the accessible name without relying
  // on the icon library forwarding children into its <svg>.
  if (member.needsReconnect) {
    return (
      <span title="Needs to reconnect" role="img" aria-label="Needs to reconnect">
        <AlertTriangle className="size-4 text-destructive" aria-hidden />
      </span>
    );
  }
  return (
    <span title="Hasn't connected yet" role="img" aria-label="Hasn't connected yet">
      <Clock className="size-4 text-muted-foreground" aria-hidden />
    </span>
  );
}

/** Confirmation before removing a member. Two-step on purpose: it revokes
 * their calendar grant at Nylas as well as deleting the row, so there is no
 * undo — getting them back means adding them again and asking them to
 * reconnect. */
function RemoveMemberDialog({
  member,
  onOpenChange,
  onRemoved,
}: {
  member: MemberWithConnection;
  onOpenChange: (open: boolean) => void;
  onRemoved: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  async function handleRemove() {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/members/${member.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      if (data.grantRevokeFailed) {
        toast.warning(
          `${member.fullName} was removed, but their calendar grant couldn't be revoked — clear it in the Nylas dashboard.`
        );
      } else {
        toast.success(`${member.fullName} was removed.`);
      }
      onRemoved();
    } catch {
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove this person?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{member.fullName}</span>
            <br />
            {member.email}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          {member.connected
            ? "This also revokes their calendar access, so we stop reading their availability straight away. It can't be undone — they'd have to be added again and reconnect."
            : "They'll be removed from the roster. It can't be undone, but you can add them again at any time."}
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Keep them
          </Button>
          <Button type="button" variant="destructive" onClick={handleRemove} disabled={submitting}>
            {submitting ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
