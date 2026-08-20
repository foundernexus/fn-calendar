"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProviderIcon } from "@/components/provider-icon";
import type { CalendarProvider } from "@/lib/calendar";

/** Our own buttons, so the member picks the provider before leaving the page.
 *
 * Originally this existed to skip Nylas's hosted picker, which carried their
 * logo. That page is gone entirely now, but the two buttons stay: the choice
 * has to be made somewhere, and making it here means the next screen someone
 * sees is their own provider's, with nothing in between. */
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
      // calendar connect needed); anyone else gets `url` — their provider's own
      // OAuth screen.
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
            className="flex h-12 w-full items-center justify-center gap-3 rounded-md border border-border bg-card text-sm font-medium text-foreground shadow-card transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-60"
          >
            <ProviderIcon provider={provider.id} className="size-5 shrink-0" />
            {pending === provider.id ? "Continuing…" : provider.label}
          </button>
        ))}
      </div>

      {/* Google still warns that the app isn't verified, and the honest
          reaction to that screen is to stop. Warned here rather than in the
          invite message: the invite is read once and days earlier, this is read
          in the second it matters.
          The note used to explain "nylas.com" as well. That name is gone now
          that the app talks to Google directly — the screen shows our own
          domain — so mentioning it would only introduce a company nobody has
          heard of. What's left is the unverified warning, which only Google's
          review removes. */}
      <div className="rounded-lg border border-border bg-secondary/40 p-3 text-xs leading-relaxed text-muted-foreground">
        <p className="font-medium text-foreground">
          Google will say this app isn&apos;t verified yet.
        </p>
        <p className="mt-1">
          That&apos;s expected — our review with Google is still in progress. Choose{" "}
          <span className="text-foreground">Advanced</span> →{" "}
          <span className="text-foreground">Continue</span>.
        </p>
        <p className="mt-1">
          You&apos;re granting calendar access only — no email, no files, no contacts.
        </p>
      </div>
    </form>
  );
}
