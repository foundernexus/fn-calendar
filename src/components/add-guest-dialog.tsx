"use client";

import { useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MemberWithConnection } from "@/db/queries";

type CreatedMember = { id: number; email: string; fullName: string };

/** There's no email-invite system (deliberately out of scope — see
 * api/admin/members/route.ts) — this dialog IS the invite. It registers the
 * person so /connect recognizes their email, then hands the admin a link to
 * pass along themselves (Slack, text, whatever). The new member won't show
 * up in the guest picker until they actually connect a calendar — that list
 * only ever shows connected members — so the success state says so
 * explicitly rather than leaving the admin wondering if it worked. */
export function AddGuestDialog({
  connectUrl,
  onAdded,
}: {
  connectUrl: string;
  onAdded: (member: MemberWithConnection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedMember | null>(null);

  function reset() {
    setFullName("");
    setEmail("");
    setCreated(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, email }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      setCreated(data.member);
      onAdded({
        id: data.member.id,
        email: data.member.email,
        fullName: data.member.fullName,
        connected: false,
        isFacilitator: false,
        provider: null,
        grantEmail: null,
      });
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
      <DialogTrigger render={<Button type="button" variant="secondary" size="sm" />}>
        + Add guest
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{created.fullName} added</DialogTitle>
              <DialogDescription>
                They&apos;re registered, but won&apos;t appear as a selectable guest until they
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
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  reset();
                }}
              >
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
              <DialogTitle>Add guest</DialogTitle>
              <DialogDescription>
                Registers them so they can sign in at /connect. There&apos;s no email invite — you
                pass along the link yourself.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="guest-name">Full name</Label>
                <Input
                  id="guest-name"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Jane Doe"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="guest-email">Email</Label>
                <Input
                  id="guest-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="jane@example.com"
                />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Adding…" : "Add guest"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
