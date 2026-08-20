import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy · FounderNexus Scheduler",
  description:
    "What FounderNexus Scheduler collects from your calendar, why, and how to remove it.",
};

/** Required for Google OAuth verification: the consent screen links here, and
 * reviewers check that it is publicly reachable without signing in and that it
 * names the Google scopes actually requested. Keep the scope list in this file
 * in sync with the scopes in src/lib/calendar/google.ts — a mismatch between
 * what the app requests and what this page discloses is a standard
 * verification rejection.
 *
 * DRAFT — written to satisfy Google's verification requirements and to be
 * accurate about what the code does. It has not been reviewed by a lawyer.
 * Have counsel read it before you rely on it for anything beyond the review. */
export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-bold text-foreground">Privacy Policy</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Last updated 19 August 2026
      </p>

      <div className="mt-8 space-y-8 text-sm leading-relaxed text-foreground">
        <section>
          <h2 className="text-base font-semibold">Who we are</h2>
          <p className="mt-2 text-muted-foreground">
            FounderNexus Scheduler (&ldquo;the Scheduler&rdquo;) is an internal
            scheduling tool operated by FounderNexus. It finds meeting times
            that work for every participant and puts the resulting event on
            their calendars. Contact us at{" "}
            <a className="underline" href="mailto:tobias@foundernexus.com">
              tobias@foundernexus.com
            </a>
            .
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold">What we access in your Google Account</h2>
          <p className="mt-2 text-muted-foreground">
            When you connect your calendar we ask Google for exactly two
            permissions, and nothing else:
          </p>
          <ul className="mt-3 space-y-3 text-muted-foreground">
            <li>
              <code className="text-xs">calendar.readonly</code> — to read your
              calendar list and your <strong>free/busy times</strong>. This is
              how we work out when everyone is available.
            </li>
            <li>
              <code className="text-xs">calendar.events</code> — to create and
              update the meetings you agree to attend.
            </li>
          </ul>
          <p className="mt-3 text-muted-foreground">
            We do <strong>not</strong> request access to your email, your
            contacts, or your files. We deliberately do not request Google&rsquo;s
            broader <code className="text-xs">calendar</code> permission, which
            would also allow deleting calendars and changing who they are shared
            with.
          </p>
          <p className="mt-3 text-muted-foreground">
            Although we can read your calendar, we only ever ask for{" "}
            <strong>free/busy information</strong> — blocks of time marked busy,
            with no titles, descriptions, locations or guests. The Scheduler
            never reads the contents of your existing events.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold">What we store</h2>
          <ul className="mt-2 space-y-2 text-muted-foreground">
            <li>
              <strong>About you:</strong> your name, email address and time
              zone.
            </li>
            <li>
              <strong>Your connection:</strong> which provider you connected,
              the email address of that calendar, and an authorisation token —
              encrypted at rest — that lets the Scheduler check your
              availability and add sessions. We never see or store your
              password. You can withdraw the authorisation at any time, either
              by disconnecting in the Scheduler or from your Google or Microsoft
              account settings.
            </li>
            <li>
              <strong>Your availability preferences:</strong> the days and times
              you have said you are generally free.
            </li>
            <li>
              <strong>Meetings we create:</strong> title, description, time,
              time zone, meeting link, and who was invited.
            </li>
          </ul>
          <p className="mt-3 text-muted-foreground">
            We do not store your calendar events, and free/busy results are used
            to answer a search and are not written to our database.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold">Who we share it with</h2>
          <p className="mt-2 text-muted-foreground">
            We do not sell your data, use it for advertising, or use it to train
            AI models. It is shared only with the services that make the product
            work:
          </p>
          <ul className="mt-3 space-y-2 text-muted-foreground">
            <li>
              <strong>Neon</strong> — hosts our database, including the
              encrypted authorisation token for your calendar.
            </li>
            <li>
              <strong>Vercel</strong> — hosts the application.
            </li>
          </ul>
          <p className="mt-3 text-muted-foreground">
            The Scheduler talks to Google Calendar and Microsoft Outlook
            directly. No third-party calendar provider sits in between, and
            nobody else receives or stores your calendar data.
          </p>
          <p className="mt-3 text-muted-foreground">
            Other members can see your name and that you are available at a
            given time. They cannot see your calendar.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold">Limited Use</h2>
          <p className="mt-2 text-muted-foreground">
            The Scheduler&rsquo;s use of information received from Google APIs
            adheres to the{" "}
            <a
              className="underline"
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noreferrer"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold">Removing your data</h2>
          <p className="mt-2 text-muted-foreground">
            You can disconnect your calendar at any time from your settings
            page, which revokes our access. You can also revoke it directly at{" "}
            <a
              className="underline"
              href="https://myaccount.google.com/permissions"
              target="_blank"
              rel="noreferrer"
            >
              myaccount.google.com/permissions
            </a>
            . To have your account and its data deleted entirely, email{" "}
            <a className="underline" href="mailto:tobias@foundernexus.com">
              tobias@foundernexus.com
            </a>{" "}
            and we will action it within 30 days.
          </p>
        </section>
      </div>
    </div>
  );
}
