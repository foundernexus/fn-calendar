import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service · FounderNexus Scheduler",
  description: "The terms you agree to when using FounderNexus Scheduler.",
};

/** Required for Google OAuth verification alongside /privacy — the consent
 * screen links here and reviewers check it is publicly reachable.
 *
 * DRAFT — not reviewed by a lawyer. Sufficient for the verification
 * submission; have counsel read it before relying on it further. */
export default function TermsPage() {
  return (
    <div className="mx-auto max-w-2xl py-16">
      <h1 className="text-2xl font-bold text-foreground">Terms of Service</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Last updated 17 August 2026
      </p>

      <div className="mt-8 space-y-8 text-sm leading-relaxed text-foreground">
        <section>
          <h2 className="text-base font-semibold">The service</h2>
          <p className="mt-2 text-muted-foreground">
            FounderNexus Scheduler finds meeting times that work for a group and
            creates the resulting calendar event. It is operated by FounderNexus
            and provided to invited members of the FounderNexus community.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold">Who can use it</h2>
          <p className="mt-2 text-muted-foreground">
            Access is by invitation. You need an account registered by an
            administrator, and you must connect a calendar you are entitled to
            use. Do not connect a calendar belonging to someone else, and do not
            share your access with anyone.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold">What we do with your calendar</h2>
          <p className="mt-2 text-muted-foreground">
            With your permission we read your free/busy times to find slots that
            suit everyone, and we create events you are scheduled into. We do not
            read the contents of your existing events, and we do not modify or
            delete events we did not create. Full detail is in our{" "}
            <a className="underline" href="/privacy">
              Privacy Policy
            </a>
            .
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold">Your responsibilities</h2>
          <p className="mt-2 text-muted-foreground">
            Keep your availability accurate — other people rely on it when
            booking. Turn up to sessions you accept, or cancel early enough for
            someone else to take the slot. Do not attempt to gain access to
            other members&rsquo; data or interfere with the service.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold">Ending your use</h2>
          <p className="mt-2 text-muted-foreground">
            You can disconnect your calendar at any time from your settings
            page, and you can ask us to delete your account by emailing{" "}
            <a className="underline" href="mailto:tobias@foundernexus.com">
              tobias@foundernexus.com
            </a>
            . We may suspend access that is being misused or that puts other
            members&rsquo; data at risk.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold">No warranty</h2>
          <p className="mt-2 text-muted-foreground">
            The Scheduler is provided as-is. We work hard to keep it accurate
            and available, but we do not guarantee it will be uninterrupted or
            error-free, and we are not liable for meetings missed, double-booked
            or scheduled in error. Always treat your own calendar as the source
            of truth.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold">Changes</h2>
          <p className="mt-2 text-muted-foreground">
            We may update these terms as the product develops. If a change
            materially affects you, we will let you know at the email address on
            your account.
          </p>
        </section>
      </div>
    </div>
  );
}
