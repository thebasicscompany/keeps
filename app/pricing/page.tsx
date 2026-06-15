/**
 * app/pricing/page.tsx
 *
 * Public marketing pricing page — the QR / "Pricing" target.
 * Static, on-brand tiered pricing (Teams / Business / Enterprise). The live
 * Clerk subscribe flow lives in /settings/billing, where the user has an
 * organization context. Keep the tiers here in sync with the Clerk plans.
 */

import type { Metadata } from "next";
import Link from "next/link";
import type { Route } from "next";
import { Header, Footer, CONTACT_URL } from "../keeps-landing";

export const metadata: Metadata = {
  title: "Pricing — Keeps",
  description:
    "Pricing that scales with your team. Teams $15/mo, Business $50/mo, or Enterprise.",
};

type Tier = {
  name: string;
  price: string;
  cadence: string;
  blurb: string;
  size: string;
  features: string[];
  cta: { label: string; href: string; external: boolean };
  featured: boolean;
};

const tiers: Tier[] = [
  {
    name: "Teams",
    price: "$15",
    cadence: "/ month",
    blurb: "For small teams getting started.",
    size: "Up to 5 members",
    features: [
      "All integrations — Slack, Gmail, Calendar",
      "Unlimited loops, reminders & nudges",
      "Company knowledge graph & reports",
      "Email support",
    ],
    cta: { label: "Get started", href: "/sign-up", external: false },
    featured: false,
  },
  {
    name: "Business",
    price: "$50",
    cadence: "/ month",
    blurb: "For growing teams that need more seats.",
    size: "Up to 20 members",
    features: [
      "Everything in Teams",
      "Up to 20 teammates",
      "Shared team workspace",
      "Priority support",
    ],
    cta: { label: "Get started", href: "/sign-up", external: false },
    featured: true,
  },
  {
    name: "Enterprise",
    price: "Let’s talk",
    cadence: "",
    blurb: "For larger orgs with custom needs.",
    size: "20+ members",
    features: [
      "Everything in Business",
      "Dedicated support",
      "SSO & security review",
      "Custom onboarding",
    ],
    cta: { label: "Contact us", href: CONTACT_URL, external: true },
    featured: false,
  },
];

export default function PricingPage() {
  return (
    <div className="keeps-page" style={{ minHeight: "100svh", background: "var(--keeps-bg)" }}>
      <Header />
      <main>
        <div style={{ maxWidth: "1040px", margin: "0 auto", padding: "72px 20px 110px" }}>
          {/* Hero */}
          <div style={{ textAlign: "center", marginBottom: "48px" }}>
            <p className="keeps-eyebrow" style={{ marginBottom: "16px" }}>
              Pricing
            </p>
            <h1
              style={{
                margin: 0,
                fontSize: "clamp(32px, 5.5vw, 46px)",
                fontWeight: 300,
                lineHeight: 1.06,
                letterSpacing: "-0.01em",
                color: "var(--keeps-ink)",
              }}
            >
              Pricing that scales with your team.
            </h1>
            <p
              className="keeps-hero-copy"
              style={{ margin: "18px auto 0", maxWidth: "520px", fontSize: "18px" }}
            >
              Every member gets the full product. Choose the plan that fits your
              team size.
            </p>
          </div>

          {/* Tiers */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "16px",
              alignItems: "stretch",
            }}
          >
            {tiers.map((tier) => (
              <div
                key={tier.name}
                className="keeps-card"
                style={{
                  position: "relative",
                  display: "flex",
                  flexDirection: "column",
                  padding: "30px 26px",
                  border: tier.featured
                    ? "1px solid rgba(30,107,79,0.5)"
                    : undefined,
                  boxShadow: tier.featured
                    ? "0 24px 70px rgba(30,107,79,0.12)"
                    : undefined,
                }}
              >
                {tier.featured ? (
                  <span
                    className="keeps-mono"
                    style={{
                      position: "absolute",
                      top: "-11px",
                      left: "26px",
                      background: "var(--keeps-green)",
                      color: "var(--keeps-ink)",
                      fontSize: "10px",
                      textTransform: "uppercase",
                      padding: "4px 10px",
                      borderRadius: "4px",
                      border: "1px solid rgba(30,107,79,0.3)",
                    }}
                  >
                    Most popular
                  </span>
                ) : null}

                <p
                  className="keeps-mono"
                  style={{
                    margin: 0,
                    fontSize: "12px",
                    textTransform: "uppercase",
                    color: "var(--keeps-green-dark)",
                  }}
                >
                  {tier.name}
                </p>
                <p style={{ margin: "6px 0 0", fontSize: "13px", color: "var(--keeps-muted)" }}>
                  {tier.blurb}
                </p>

                <div style={{ display: "flex", alignItems: "baseline", gap: "6px", marginTop: "18px" }}>
                  <span style={{ fontSize: "44px", fontWeight: 300, lineHeight: 1, color: "var(--keeps-ink)" }}>
                    {tier.price}
                  </span>
                  {tier.cadence ? (
                    <span style={{ fontSize: "14px", color: "var(--keeps-muted)" }}>{tier.cadence}</span>
                  ) : null}
                </div>
                <p
                  className="keeps-mono"
                  style={{
                    margin: "10px 0 0",
                    fontSize: "12px",
                    textTransform: "uppercase",
                    color: "var(--keeps-ink)",
                  }}
                >
                  {tier.size}
                </p>

                <div style={{ height: "1px", background: "var(--keeps-line)", margin: "22px 0" }} />

                <ul
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: "11px",
                  }}
                >
                  {tier.features.map((f) => (
                    <li
                      key={f}
                      style={{
                        display: "flex",
                        gap: "10px",
                        alignItems: "flex-start",
                        fontSize: "14px",
                        fontWeight: 300,
                        color: "var(--keeps-ink)",
                      }}
                    >
                      <span aria-hidden style={{ color: "var(--keeps-green-dark)", fontWeight: 600 }}>
                        ✓
                      </span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>

                <div style={{ marginTop: "auto", paddingTop: "26px" }}>
                  {tier.cta.external ? (
                    <a
                      className={`keeps-button ${tier.featured ? "keeps-button-primary" : "keeps-button-secondary"}`}
                      href={tier.cta.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ width: "100%" }}
                    >
                      {tier.cta.label}
                    </a>
                  ) : (
                    <Link
                      className={`keeps-button ${tier.featured ? "keeps-button-primary" : "keeps-button-secondary"}`}
                      href={tier.cta.href as Route}
                      style={{ width: "100%" }}
                    >
                      {tier.cta.label}
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>

          <p style={{ marginTop: "28px", textAlign: "center", fontSize: "13px", color: "var(--keeps-muted)" }}>
            Every plan is billed monthly and you can cancel anytime. Questions?{" "}
            <a
              href={CONTACT_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--keeps-green-dark)", textDecoration: "underline" }}
            >
              Book a 30-min call.
            </a>
          </p>
        </div>
      </main>
      <Footer />
    </div>
  );
}
