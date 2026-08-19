"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProviderIcon } from "@/components/provider-icon";
import type { CalendarProvider } from "@/lib/nylas";

/** Rendered as our own buttons rather than letting Nylas's hosted page show a
 * picker — that page carries the Nylas logo and can't be rebranded without an
 * annual Nylas contract. Naming the provider in the auth URL skips it. */
const PROVIDERS: { id: CalendarProvider; label: string }[] = [
  { id: "google", label: "Continue with Google" },
  { id: "microsoft", label: "Continue with Microsoft" },
];

export function ConnectForm({ initialEmail }: { initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail ?? "");
  // Tracks WHICH provider is in flight, not just that something is — both
  // buttons must disable during the request, but only the one that was
  // clicked should show the pending label.
  const [pending, setPending] = useState<CalendarProvider | null>(null);

  async function handleConnect(provider: CalendarProvider) {
    if (!email) {
      toast.error("Enter your email address first.");
      return;
    }
    setPending(provider);
    try {
      const res = await fetch("/api/connect/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, provider }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Something went wrong. Please try again.");
        setPending(null);
        return;
      }
      // An admin email gets `redirect` (straight to the admin dashboard, no
      // calendar connect needed); anyone else gets `url` (the Nylas hosted
      // auth flow, unchanged from before).
      window.location.href = data.redirect ?? data.url;
    } catch {
      toast.error("Something went wrong. Please try again.");
      setPending(null);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        // Enter in the email field shouldn't silently pick a provider for
        // the member — it's their calendar account, so make them choose.
        e.preventDefault();
      }}
      className="space-y-4"
    >
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
      {/* Full-width, taller than the app's usual buttons, each carrying its
          provider's mark — the shape people already know from every other
          sign-in page. Both are outlined rather than one being filled: this
          isn't a primary action and a fallback, it's a choice between two
          equals, and colouring one of them steers people towards a calendar
          that might not be theirs. */}
      <div className="flex flex-col gap-3 pt-1">
        {PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            type="button"
            disabled={pending !== null}
            onClick={() => handleConnect(provider.id)}
            className="flex h-12 w-full items-center justify-center gap-3 rounded-lg border border-border bg-card text-sm font-medium text-foreground shadow-card transition-colors hover:bg-secondary disabled:pointer-events-none disabled:opacity-60"
          >
            <ProviderIcon provider={provider.id} className="size-5 shrink-0" />
            {pending === provider.id ? "Continuing…" : provider.label}
          </button>
        ))}
      </div>
    </form>
  );
}
