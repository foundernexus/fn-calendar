export const metadata = {
  title: "Privacy Policy — FounderNexus Scheduler",
};

const SECTIONS: { heading: string; body: React.ReactNode }[] = [
  {
    heading: "What this tool is",
    body: (
      <p>
        FounderNexus Scheduler is an internal scheduling tool that lets FounderNexus
        members connect their calendar so we can find meeting times for expert sessions
        without email polls.
      </p>
    ),
  },
  {
    heading: "Google user data we access",
    body: (
      <p>
        Via the Google Calendar API (through Nylas, our calendar infrastructure
        provider), we access calendar free/busy information — whether time slots are
        busy or free — and create calendar events on the member&apos;s calendar with
        their consent. We request the calendar scope and basic profile information
        (name, email) to identify the connected account.
      </p>
    ),
  },
  {
    heading: "What we explicitly do not access, store, or display",
    body: (
      <p>
        Event titles, descriptions, attendee lists, locations, meeting links, or any
        content of existing calendar events.
      </p>
    ),
  },
  {
    heading: "How data is used",
    body: (
      <p>
        Solely to compute overlapping availability among selected members and to
        create expert-session calendar invitations. Never for advertising, profiling,
        or sale to third parties. Data is not shared with any third party other than
        Nylas, which maintains the calendar connection on our behalf.
      </p>
    ),
  },
  {
    heading: "Storage & security",
    body: (
      <p>
        We store only a connection identifier (Nylas grant ID), the member&apos;s
        email/name, their manually set availability preferences, and events created by
        this tool. We never store Google passwords or OAuth tokens. Data is stored in
        our database (Neon) with access restricted to FounderNexus administrators.
      </p>
    ),
  },
  {
    heading: "Retention & deletion",
    body: (
      <p>
        Members can disconnect their calendar at any time from their availability
        page, which revokes our access. Members may request full deletion of their
        data by emailing us; we honor requests within 30 days.
      </p>
    ),
  },
  {
    heading: "Compliance note",
    body: (
      <p>
        FounderNexus Scheduler&apos;s use and transfer of information received from
        Google APIs adheres to the{" "}
        <a
          href="https://developers.google.com/terms/api-services-user-data-policy"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-4 hover:no-underline"
        >
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>
    ),
  },
  {
    heading: "Contact",
    body: (
      // TODO: swap in the real contact address before submitting for Google
      // verification — reviewers will check that this resolves to something.
      <p>
        Questions about this policy or your data? Contact us at{" "}
        <a href="mailto:privacy@foundernexus.com" className="text-primary underline underline-offset-4 hover:no-underline">
          privacy@foundernexus.com
        </a>
        .
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl py-16">
      <h1 className="text-2xl font-bold text-foreground">
        FounderNexus Scheduler — Privacy Policy
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">Last updated August 2026.</p>

      <div className="mt-8 space-y-8">
        {SECTIONS.map((section) => (
          <section key={section.heading}>
            <h2 className="text-base font-semibold text-foreground">{section.heading}</h2>
            <div className="mt-2 space-y-3 text-sm leading-relaxed text-muted-foreground">
              {section.body}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
