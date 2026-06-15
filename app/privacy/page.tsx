/**
 * app/privacy/page.tsx
 *
 * Public marketing-facing Privacy page for Keeps.
 *
 * Route: /privacy
 *
 * DRAFT COPY: needs Arav's review and sign-off before shipping.
 * Claims in this page are limited to what Phase 6 actually shipped:
 * retention scrub, delete/export controls, no-training commitment.
 * No SOC2/encryption-at-rest claims are made.
 */

import type { ReactNode } from "react";
import { SecondaryFooter, SecondaryHeader } from "../keeps-site-chrome";

function PolicySection({
  children,
  index,
  title,
}: {
  children: ReactNode;
  index: string;
  title: string;
}) {
  return (
    <section className="keeps-card keeps-document-card">
      <p className="keeps-document-index">{index}</p>
      <div className="keeps-document-card-copy">
        <h2>{title}</h2>
        <div className="keeps-document-prose">{children}</div>
      </div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div className="keeps-page keeps-document-page">
      <SecondaryHeader active="privacy" />

      <main>
        <section className="keeps-section keeps-document-section">
          <div className="keeps-side" />
          <div className="keeps-section-inner keeps-document-shell">
            <header className="keeps-card keeps-document-hero">
              <p className="keeps-eyebrow">Privacy</p>
              <h1>Private by default.</h1>
              <p>
                Keeps is built for founders and operators who share sensitive work over email. Here
                is exactly what we store, how long we keep it, and what you can do with it.
              </p>
              <span>Last updated: June 2025. Draft pending final review.</span>
            </header>

            <div className="keeps-document-content" data-testid="privacy-content">
              <PolicySection index="01" title="What Keeps stores">
                <p>
                  Keeps only ever sees what you explicitly send it. That means emails you forward,
                  CC, or BCC to your Keeps capture address, nothing else. We do not connect to your
                  inbox, we do not read emails in the background, and we do not import contacts.
                </p>
                <p>From each email you send us, we store:</p>
                <ul>
                  <li>
                    <span className="keeps-document-strong">The raw email body</span>, kept for a
                    default of{" "}
                    <span data-testid="retention-default" className="keeps-document-strong">
                      30 days
                    </span>
                    , then permanently deleted.
                  </li>
                  <li>
                    <span className="keeps-document-strong">Extracted loops</span>: the open
                    threads, commitments, and follow-ups we surface. These remain until you delete
                    them.
                  </li>
                  <li>
                    <span className="keeps-document-strong">Short source quotes</span>: brief
                    excerpts from your email that a loop cites as its origin. These stay alongside
                    the loop and are removed when you delete the loop or the source email.
                  </li>
                </ul>
                <p>
                  Nothing else. No message metadata from threads you did not send us. No attachments
                  beyond what is needed to extract loops.
                </p>
              </PolicySection>

              <PolicySection index="02" title="Raw email retention">
                <p>
                  By default, the original email body is permanently deleted after{" "}
                  <span data-testid="retention-scrub" className="keeps-document-strong">
                    30 days
                  </span>
                  . The loops and short quotes extracted from it remain; they are the record you
                  wanted to keep.
                </p>
                <p>
                  You can change this window in{" "}
                  <span className="keeps-document-strong">Settings → Privacy</span>: 30 days
                  (default), 90 days, 365 days, or &ldquo;keep until I delete.&rdquo;
                </p>
              </PolicySection>

              <PolicySection index="03" title="Your controls">
                <p>
                  You are in full control of your data from{" "}
                  <span className="keeps-document-strong">Settings</span>:
                </p>
                <ul>
                  <li>
                    <span data-testid="control-view" className="keeps-document-strong">
                      View your data
                    </span>{" "}
                    : browse every email and loop Keeps has on record for you.
                  </li>
                  <li>
                    <span data-testid="control-export" className="keeps-document-strong">
                      Export everything as JSON
                    </span>{" "}
                    : download a full archive of your loops, quoted excerpts, and email metadata in
                    one click.
                  </li>
                  <li>
                    <span data-testid="control-delete-email" className="keeps-document-strong">
                      Delete an individual source email
                    </span>{" "}
                    : permanently removes the raw body, all extracted loops, and every quote derived
                    from that email.
                  </li>
                  <li>
                    <span data-testid="control-delete-account" className="keeps-document-strong">
                      Delete your account and all data
                    </span>{" "}
                    : wipes everything associated with your account, immediately and irreversibly.
                  </li>
                </ul>
                <p>All of these are available directly in your settings, no support ticket required.</p>
              </PolicySection>

              <PolicySection index="04" title="We do not train on your content">
                <p>
                  We do not use your emails, extracted loops, or any content you send to Keeps to
                  train or fine-tune AI models, ours or anyone else&apos;s.
                </p>
                <p>
                  When Keeps uses an LLM to extract loops from an email, that request is processed
                  in-flight and the raw content is not retained by our model provider beyond the
                  standard API call window.
                </p>
              </PolicySection>

              <PolicySection index="05" title="Third parties">
                <p>
                  Keeps does not sell your data. We use a small number of infrastructure providers
                  (hosting, database, authentication, transactional email) under data processing
                  agreements. We share only the minimum data each provider needs to function.
                </p>
                <p>
                  When you connect an integration (e.g. Slack, Google Calendar), that connection is
                  explicit. You approve it, and you can disconnect it at any time from{" "}
                  <span className="keeps-document-strong">Settings → Connectors</span>. Keeps never
                  takes an action through a connector without your approval on that specific action.
                </p>
              </PolicySection>

              <PolicySection index="06" title="Questions">
                <p>
                  If you have a question about your data that is not answered here, email us at{" "}
                  <a className="keeps-document-link" href="mailto:privacy@keeps.email">
                    privacy@keeps.email
                  </a>
                  .
                </p>
              </PolicySection>
            </div>
          </div>
          <div className="keeps-side" />
        </section>
      </main>

      <SecondaryFooter />
    </div>
  );
}
