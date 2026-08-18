"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** One button, not a provider picker: /api/connect/start deliberately omits
 * `provider`, so Nylas's hosted login screen shows the Google/Microsoft choice
 * (see buildHostedAuthUrl for why we went back to that). Adding buttons here
 * as well would ask people to choose twice. */
export function ConnectForm({ initialEmail }: { initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail ?? "");
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
