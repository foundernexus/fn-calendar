"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
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
import { ROLES, type PersonRole } from "@/components/add-person-dialog";
import { handleExpiredSession } from "@/lib/session-expired";

export type EditablePerson = {
  id: number;
  fullName: string;
  email: string;
  isAdvisor: boolean;
  isFacilitator: boolean;
};

function roleOf(p: EditablePerson): PersonRole {
  // Advisor wins when someone carries both, matching how the directory groups
  // them — otherwise opening this dialog would silently propose demoting them.
  if (p.isAdvisor) return "advisor";
  if (p.isFacilitator) return "team";
  return "founder";
}

/** Corrects a name or a role after the fact.
 *
 * Until now the only way to fix "tobias" was to remove the person and add them
 * again — which revokes their calendar, drops their stated availability, and is
 * refused outright once they have been in a session. A typo should not cost
 * that.
 *
 * The email is shown but not editable, and that's the deliberate part: it's the
 * address they sign in with and the one an OAuth account is matched against, so
 * changing it here would quietly lock them out of an account they had already
 * connected. The server refuses it too. */
export function EditPersonDialog({
  person,
  canSetTeam,
  onClose,
}: {
  /** Null closes the dialog — the caller owns which row is being edited. */
  person: EditablePerson | null;
  /** Owner-only, same rule as adding a Team member: the flag grants admin. */
  canSetTeam: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={person !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {/* Keyed on the person, so opening a different row REMOUNTS the form and
            its fields initialise from the new props. The obvious alternative —
            one long-lived form with an effect copying props into state — is the
            pattern that shows the previous person's name for a frame, and it is
            what react-hooks/set-state-in-effect exists to catch. */}
        {person && (
          <EditPersonForm
            key={person.id}
            person={person}
            canSetTeam={canSetTeam}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditPersonForm({
  person,
  canSetTeam,
  onClose,
}: {
  person: EditablePerson;
  canSetTeam: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [fullName, setFullName] = useState(person.fullName);
  const [role, setRole] = useState<PersonRole>(roleOf(person));
  const [saving, setSaving] = useState(false);

  const availableRoles = (Object.keys(ROLES) as PersonRole[]).filter(
    // Someone already on the team stays listed even for a non-owner, or the
    // Select would have no value to show and would read as blank.
    (r) => r !== "team" || canSetTeam || roleOf(person) === "team",
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = fullName.trim();
    if (!trimmed) {
      toast.error("Enter a name.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/admin/members/${person.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName: trimmed, ...ROLES[role].flags }),
      });
      if (handleExpiredSession(res)) return;
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't save the changes. Please try again.");
        return;
      }
      toast.success(`${trimmed} updated.`);
      onClose();
      // The People page is a server component, so the row only shows the new
      // name once its data is refetched. Without this the save succeeds and the
      // table carries on showing the old one.
      router.refresh();
    } catch {
      toast.error("Couldn't save the changes. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>Edit person</DialogTitle>
        <DialogDescription>
          Their calendar, availability and sessions stay exactly as they are.
        </DialogDescription>
      </DialogHeader>

      <div className="mt-4 flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-name">Name</Label>
          <Input
            id="edit-name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoFocus
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Email</Label>
          <p className="text-sm text-muted-foreground">{person?.email}</p>
          <p className="text-xs text-muted-foreground">
            Can&apos;t be changed — it&apos;s the address they sign in with. Wrong address? Remove
            them and add them again.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-role">Role</Label>
          <Select value={role} onValueChange={(v) => setRole(v as PersonRole)}>
            <SelectTrigger id="edit-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableRoles.map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLES[r].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{ROLES[role].hint}</p>
        </div>
      </div>

      <DialogFooter className="mt-6">
        <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}
