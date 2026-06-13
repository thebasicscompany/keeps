/**
 * app/privacy/page.tsx
 *
 * Public marketing-facing Privacy page for Keeps.
 *
 * Route: /privacy
 *
 * DRAFT COPY — needs Arav's review and sign-off before shipping.
 * Claims in this page are limited to what Phase 6 actually shipped:
 * retention scrub, delete/export controls, no-training commitment.
 * No SOC2/encryption-at-rest claims are made.
 */

import Link from "next/link";
import type { Route } from "next";

// ---------------------------------------------------------------------------
// Design tokens (match app/page.tsx landing page exactly)
// ---------------------------------------------------------------------------

const mutedClass = "text-[#6F6F66]";

// ---------------------------------------------------------------------------
// Section building blocks
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-[#E2E2DD] pt-10">
      <h2 className="mb-4 text-[22px] font-bold leading-tight tracking-tight text-[#14140F]">
        {title}
      </h2>
      <div className={`space-y-3 text-[16px] leading-[1.7] font-medium ${mutedClass}`}>
        {children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PrivacyPage() {
  return (
    <div className="min-h-svh bg-[#FAFAF8] text-[#14140F]">
      {/* Top bar */}
      <header className="mx-auto flex w-full max-w-[800px] items-center justify-between px-6 pt-7 pb-2 sm:px-10">
        <Link
          href={"/" as Route}
          className="text-[22px] font-bold tracking-tight text-[#14140F] transition-colors hover:text-[#1E6B4F]"
        >
          Keeps
        </Link>
        <Link
          href={"/sign-in" as Route}
          className="text-sm font-medium text-[#6F6F66] transition-colors hover:text-[#14140F]"
        >
          Sign in
        </Link>
      </header>

      {/* Body */}
      <main className="mx-auto w-full max-w-[800px] px-6 pt-12 pb-20 sm:px-10">
        {/* Page heading */}
        <div className="mb-10">
          <p className="mb-3 text-[15px] font-semibold text-[#1E6B4F]">Privacy</p>
          <h1 className="text-[44px] font-bold leading-[1.05] tracking-tight text-[#14140F] sm:text-[52px]">
            Private by default.
          </h1>
          <p className={`mt-5 max-w-[580px] text-[18px] leading-[1.65] font-medium ${mutedClass}`}>
            Keeps is built for founders and operators who share sensitive work over email. Here is
            exactly what we store, how long we keep it, and what you can do with it.
          </p>
          <p className={`mt-3 text-[14px] font-medium ${mutedClass}`}>
            Last updated: June 2025.{" "}
            <span className="italic">Draft — pending final review.</span>
          </p>
        </div>

        <div className="space-y-10" data-testid="privacy-content">
          {/* ---------------------------------------------------------------- */}
          <Section title="What Keeps stores">
            <p>
              Keeps only ever sees what you explicitly send it. That means emails you forward, CC, or
              BCC to your Keeps capture address — nothing else. We do not connect to your inbox, we
              do not read emails in the background, and we do not import contacts.
            </p>
            <p>
              From each email you send us, we store:
            </p>
            <ul className="ml-5 list-disc space-y-1.5">
              <li>
                <span className="font-semibold text-[#14140F]">The raw email body</span> — kept for
                a default of{" "}
                <span data-testid="retention-default" className="font-semibold text-[#14140F]">
                  30 days
                </span>
                , then permanently deleted.
              </li>
              <li>
                <span className="font-semibold text-[#14140F]">Extracted loops</span> — the open
                threads, commitments, and follow-ups we surface. These remain until you delete them.
              </li>
              <li>
                <span className="font-semibold text-[#14140F]">Short source quotes</span> — brief
                excerpts from your email that a loop cites as its origin. These stay alongside the
                loop and are removed when you delete the loop or the source email.
              </li>
            </ul>
            <p>
              Nothing else. No message metadata from threads you did not send us. No attachments
              beyond what is needed to extract loops.
            </p>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section title="Raw email retention">
            <p>
              By default, the original email body is permanently deleted after{" "}
              <span data-testid="retention-scrub" className="font-semibold text-[#14140F]">
                30 days
              </span>
              . The loops and short quotes extracted from it remain — they are the record you wanted
              to keep.
            </p>
            <p>
              You can change this window in{" "}
              <span className="font-semibold text-[#14140F]">Settings → Privacy</span>: 30 days
              (default), 90 days, 365 days, or &ldquo;keep until I delete.&rdquo;
            </p>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section title="Your controls">
            <p>
              You are in full control of your data from{" "}
              <span className="font-semibold text-[#14140F]">Settings</span>:
            </p>
            <ul className="ml-5 list-disc space-y-1.5">
              <li>
                <span
                  data-testid="control-view"
                  className="font-semibold text-[#14140F]"
                >
                  View your data
                </span>{" "}
                — browse every email and loop Keeps has on record for you.
              </li>
              <li>
                <span
                  data-testid="control-export"
                  className="font-semibold text-[#14140F]"
                >
                  Export everything as JSON
                </span>{" "}
                — download a full archive of your loops, quoted excerpts, and email metadata in one
                click.
              </li>
              <li>
                <span
                  data-testid="control-delete-email"
                  className="font-semibold text-[#14140F]"
                >
                  Delete an individual source email
                </span>{" "}
                — permanently removes the raw body, all extracted loops, and every quote derived from
                that email.
              </li>
              <li>
                <span
                  data-testid="control-delete-account"
                  className="font-semibold text-[#14140F]"
                >
                  Delete your account and all data
                </span>{" "}
                — wipes everything associated with your account, immediately and irreversibly.
              </li>
            </ul>
            <p>
              All of these are available directly in your settings — no support ticket required.
            </p>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section title="We do not train on your content">
            <p>
              We do not use your emails, extracted loops, or any content you send to Keeps to train
              or fine-tune AI models — ours or anyone else&apos;s.
            </p>
            <p>
              When Keeps uses an LLM to extract loops from an email, that request is processed
              in-flight and the raw content is not retained by our model provider beyond the
              standard API call window.
            </p>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section title="Third parties">
            <p>
              Keeps does not sell your data. We use a small number of infrastructure providers
              (hosting, database, authentication, transactional email) under data processing
              agreements. We share only the minimum data each provider needs to function.
            </p>
            <p>
              When you connect an integration (e.g. Slack, Google Calendar), that connection is
              explicit — you approve it, and you can disconnect it at any time from{" "}
              <span className="font-semibold text-[#14140F]">Settings → Connectors</span>. Keeps
              never takes an action through a connector without your approval on that specific
              action.
            </p>
          </Section>

          {/* ---------------------------------------------------------------- */}
          <Section title="Questions">
            <p>
              If you have a question about your data that is not answered here, email us at{" "}
              <a
                href="mailto:privacy@keeps.email"
                className="font-semibold text-[#14140F] underline underline-offset-2 hover:text-[#1E6B4F]"
              >
                privacy@keeps.email
              </a>
              .
            </p>
          </Section>
        </div>
      </main>

      {/* Footer */}
      <footer className="mx-auto flex w-full max-w-[800px] items-center justify-between border-t border-[#E2E2DD] px-6 py-7 sm:px-10">
        <span className="text-[15px] font-bold text-[#14140F]">Keeps</span>
        <span className={`text-[13px] font-medium ${mutedClass}`}>
          <Link
            href={"/" as Route}
            className="transition-colors hover:text-[#14140F]"
          >
            Home
          </Link>
        </span>
      </footer>
    </div>
  );
}
