"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type CreatedMember = { id: number; email: string; fullName: string };

/** The three roles the People page groups by. Kept as one value the admin
 * picks rather than the pair of booleans the database stores: nobody is
 * choosing "is a facilitator AND an advisor", they're choosing which of three
 * lists this person belongs in. The flags are derived on submit. */
const ROLES = {
  founder: {
    label: "Founder",
    hint: "Scheduled into sessions as a participant. The default.",
    flags: { isAdvisor: false, isFacilitator: false },
  },
  advisor: {
    label: "Advisor",
    hint: "Gets their own dashboard, and is picked from the Advisor field when booking rather than the founder list.",
    flags: { isAdvisor: true, isFacilitator: false },
  },
  team: {
    label: "Team",
    hint: "FounderNexus staff who run sessions — they can be picked as the session lead.",
    flags: { isAdvisor: false, isFacilitator: true },
  },
} as const;

export type PersonRole = keyof typeof ROLES;

/** There's no email-invite system (deliberately out of scope — see
 * api/admin/members/route.ts), so this dialog IS the invite. It registers the
 * person so /connect recognises their email, then hands the admin a link to
 * pass along themselves. They won't appear in any booking picker until they
 * actually connect a calendar, so the success state says so outright rather
 * than leaving the admin wondering whether it worked. */
export function AddPersonDialog({
  connectUrl,
  defaultRole = "founder",
  canAddTeam,
  onAdded,
}: {
  connectUrl: string;
  defaultRole?: PersonRole;
  /** Owner-only. Marking someone Team grants them admin, so Team members can
   * add founders and advisors but not more staff. The server enforces this
   * too — hiding the option is the courtesy, not the rule. */
  canAddTeam: boolean;
  onAdded?: () => void;
}) {
  const router = useRouter();
  // Team is simply absent from the list for anyone who cannot grant it, rather
  // than shown and rejected on submit.
  const availableRoles = (Object.keys(ROLES) as PersonRole[]).filter(
    (r) => r !== "team" || canAddTeam
  );
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<PersonRole>(defaultRole);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedMember | null>(null);

  function reset() {
    setFullName("");
    setEmail("");
    // Role deliberately survives — an admin adding advisors is almost always
    // adding several in a row, and "Add another" shouldn't quietly drop them
    // back to creating founders.
    setCreated(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, email, ...ROLES[role].flags }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      setCreated(data.member);
      // Refreshes here rather than leaving it to the caller, so this can be
      // dropped into a Server Component (the page header) without that page
      // needing to become a client one just to pass a callback down.
      router.refresh();
      onAdded?.();
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(connectUrl);
      toast.success("Link copied.");
    } catch {
      toast.error("Couldn't copy — copy it manually instead.");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      {/* Filled, not secondary: this is the one thing this page is for, and a
          grey button sitting beside the title read as an afterthought. The
          icon replaces a literal "+" so its stroke weight matches the other
          icons in the table below. */}
      <DialogTrigger render={<Button type="button" />}>
        <Plus data-icon="inline-start" />
        Add person
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{created.fullName} added</DialogTitle>
              <DialogDescription>
                They&apos;re registered, but won&apos;t be selectable for a session until they
                connect their calendar. Send them this link:
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/40 p-3">
              <code className="flex-1 truncate text-sm text-foreground">{connectUrl}</code>
              <Button type="button" variant="secondary" size="sm" onClick={copyLink}>
                Copy
              </Button>
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={reset}>
                Add another
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add person</DialogTitle>
              <DialogDescription>
                Registers them so they can sign in at /connect. There&apos;s no email invite — you
                pass along the link yourself.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="person-name">Full name</Label>
                <Input
                  id="person-name"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Jane Doe"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="person-email">Email</Label>
                <Input
                  id="person-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="jane@example.com"
                />
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <Select
                  items={Object.fromEntries(
                    availableRoles.map((key) => [key, ROLES[key].label])
                  )}
                  value={role}
                  onValueChange={(v) => v && setRole(v as PersonRole)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableRoles.map((key) => (
                      <SelectItem key={key} value={key}>
                        {ROLES[key].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{ROLES[role].hint}</p>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Adding…" : `Add ${ROLES[role].label.toLowerCase()}`}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
