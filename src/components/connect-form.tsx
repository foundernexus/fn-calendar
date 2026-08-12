"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { normalizeEmail } from "@/lib/email";

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google Calendar",
  microsoft: "Microsoft/Outlook",
  icloud: "iCloud",
};

function providerLabel(provider: string) {
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function ConnectForm({
  initialEmail,
  initialStatus,
  initialProvider,
  initialGrantEmail,
}: {
  initialEmail?: string;
  initialStatus: "connected" | "not_connected";
  initialProvider?: string;
  initialGrantEmail?: string;
}) {
  const [email, setEmail] = useState(initialEmail ?? "");
  const [status, setStatus] = useState(initialStatus);
  const [provider, setProvider] = useState(initialProvider);
  const [grantEmail, setGrantEmail] = useState(initialGrantEmail);
  const [submitting, setSubmitting] = useState(false);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/connect/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      // An admin email gets `redirect` (straight to the admin dashboard, no
      // calendar connect needed); anyone else gets `url` (the Nylas hosted
      // auth flow, unchanged from before).
      window.location.href = data.redirect ?? data.url;
    } catch {
      toast.error("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  async function handleDisconnect() {
    setSubmitting(true);
    try {
      const res = await fetch("/api/connect/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      setStatus("not_connected");
      setProvider(undefined);
      setGrantEmail(undefined);
      toast.success("Calendar disconnected.");
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (status === "connected") {
    return (
      <div className="rounded-lg border border-border bg-card p-6 shadow-card">
        <div className="flex items-center gap-2">
          <Badge className="bg-accent text-accent-foreground">Connected</Badge>
          {provider && (
            <span className="text-sm text-muted-foreground">{providerLabel(provider)}</span>
          )}
        </div>
        <p className="mt-3 text-sm text-foreground">{email}</p>
        {grantEmail && normalizeEmail(grantEmail) !== normalizeEmail(email) && (
          <p className="mt-1 text-sm text-muted-foreground">
            Connected calendar: {grantEmail}
          </p>
        )}
        <Button
          variant="secondary"
          className="mt-4"
          onClick={handleDisconnect}
          disabled={submitting}
        >
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleConnect} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          required
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <Button type="submit" disabled={submitting}>
        {submitting ? "Continuing…" : "Continue"}
      </Button>
    </form>
  );
}
