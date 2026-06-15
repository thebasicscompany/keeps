/**
 * app/pricing/page.tsx
 *
 * Public pricing page — the QR / "Start" target for the conference.
 * Renders Clerk Billing's per-seat Organization plans. Subscribing requires
 * a signed-in user with an active organization; the PricingTable prompts for
 * sign-in and org selection as needed.
 *
 * Plans + per-seat pricing are configured in the Clerk dashboard
 * (Subscription plans -> Plans for Organizations), not in code.
 */

import { PricingTable } from "@clerk/nextjs";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing — Keeps",
  description: "Per-seat pricing for teams. Invite your team and scale as you grow.",
};

export default function PricingPage() {
  return (
    <div className="keeps-page" style={{ minHeight: "100svh" }}>
      <main>
        <section className="keeps-section" style={{ paddingBlock: "72px" }}>
          <div className="keeps-side" />
          <div className="keeps-section-inner">
            <div style={{ marginBottom: "36px", textAlign: "center" }}>
              <p className="keeps-eyebrow">Pricing</p>
              <h1
                style={{
                  margin: "8px 0 12px",
                  fontSize: "34px",
                  fontWeight: 300,
                  lineHeight: 1.1,
                  letterSpacing: "-0.01em",
                  color: "var(--keeps-ink)",
                }}
              >
                Per-seat pricing for teams
              </h1>
              <p className="keeps-hero-copy" style={{ margin: "0 auto", maxWidth: "520px" }}>
                Invite your team and add seats as you grow — you&rsquo;re billed per
                member each month, and seats scale automatically.
              </p>
            </div>

            <PricingTable for="organization" />

            <p style={{ marginTop: "28px", textAlign: "center" }}>
              <Link className="keeps-button keeps-button-secondary" href="/">
                Back to home
              </Link>
            </p>
          </div>
          <div className="keeps-side" />
        </section>
      </main>
    </div>
  );
}
