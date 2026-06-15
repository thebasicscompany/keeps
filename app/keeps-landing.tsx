"use client";

import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";
import { useState } from "react";

const workflowSteps = [
  {
    eyebrow: "01 / Capture",
    title: "Capture without surveillance.",
    body: "Keeps only sees the threads you choose, so context is gathered deliberately, not by watching everything.",
  },
  {
    eyebrow: "02 / Track",
    title: "Turn work into memory.",
    body: "Keeps captures open loops, decisions, owners, deadlines, and source context before they disappear in inboxes.",
  },
  {
    eyebrow: "03 / Act",
    title: "Operationalize it instantly.",
    body: "Get reminders, approval-ready drafts, follow-ups, and small automations before anything slips.",
  },
];

const loops = [
  {
    source: "Priya Nair",
    summary: "Send SOC 2 report and security questionnaire",
    status: "Needs you",
    time: "Today",
  },
  {
    source: "Priya Nair",
    summary: "Spin up a two-week trial for 5 seats",
    status: "Draft ready",
    time: "This afternoon",
  },
  {
    source: "Dana",
    summary: "Budget sign-off and redlined contract",
    status: "Waiting",
    time: "Friday",
  },
];

const controlItems = [
  {
    number: "01",
    title: "Permissioned capture",
    body: "Keeps works from the messages you forward, CC, or send directly, not from everything your company says.",
  },
  {
    number: "02",
    title: "Company intelligence",
    body: "Every captured loop keeps its source email, owner, deadline, decision, and next action attached.",
  },
  {
    number: "03",
    title: "Agent-ready action",
    body: "Drafts, nudges, and lightweight automations wait for approval before anything leaves.",
  },
];

const navItems = [
  { label: "How it works", href: "#how" },
  { label: "Privacy", href: "/privacy" },
  { label: "Start", href: "/get-started" },
];

function KeepsMark() {
  return (
    <Link aria-label="Keeps home" className="keeps-logo" href="/">
      <svg
        aria-hidden="true"
        fill="none"
        height="28"
        viewBox="0 0 34 28"
        width="34"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M17 2.75L29.75 9.25L17 15.75L4.25 9.25L17 2.75Z"
          className="keeps-logo-layer keeps-logo-layer-top"
        />
        <path
          d="M7.5 13.25L17 18.1L26.5 13.25"
          className="keeps-logo-layer keeps-logo-layer-mid"
        />
        <path
          d="M7.5 18.25L17 23.1L26.5 18.25"
          className="keeps-logo-layer keeps-logo-layer-bottom"
        />
      </svg>
      <span>Keeps</span>
    </Link>
  );
}

function DotFrame() {
  return (
    <>
      <span aria-hidden="true" className="keeps-dot keeps-dot-tl" />
      <span aria-hidden="true" className="keeps-dot keeps-dot-tr" />
      <span aria-hidden="true" className="keeps-dot keeps-dot-bl" />
      <span aria-hidden="true" className="keeps-dot keeps-dot-br" />
    </>
  );
}

function Card({
  children,
  className = "",
  dots = true,
}: {
  children: ReactNode;
  className?: string;
  dots?: boolean;
}) {
  return (
    <div className={`keeps-card ${className}`}>
      {dots ? <DotFrame /> : null}
      {children}
    </div>
  );
}

function Section({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`keeps-section ${className}`}>
      <div className="keeps-side" />
      <div className="keeps-section-inner">{children}</div>
      <div className="keeps-side" />
    </section>
  );
}

function Header() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className={`keeps-mobile-nav ${open ? "is-open" : ""}`}>
        <nav aria-hidden={!open}>
          {navItems.map((item, index) => (
            <a
              href={item.href}
              key={item.label}
              onClick={() => setOpen(false)}
              style={{ transitionDelay: open ? `${80 + index * 55}ms` : "0ms" }}
              tabIndex={open ? 0 : -1}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </div>
      <header className="keeps-header">
        <div className="keeps-side" />
        <nav className="keeps-nav">
          <KeepsMark />
          <div className="keeps-nav-links">
            {navItems.map((item) => (
              <a href={item.href} key={item.label}>
                {item.label}
              </a>
            ))}
          </div>
          <div className="keeps-nav-actions">
            <Link className="keeps-button keeps-button-secondary keeps-signin" href={"/sign-in" as Route}>
              Sign in
            </Link>
            <button
              aria-expanded={open}
              aria-label={open ? "Close menu" : "Open menu"}
              className="keeps-button keeps-button-secondary keeps-menu-button"
              onClick={() => setOpen((value) => !value)}
              type="button"
            >
              <span className={`keeps-menu-glyph ${open ? "is-open" : ""}`}>
                <span />
                <span />
              </span>
            </button>
          </div>
        </nav>
        <div className="keeps-side" />
      </header>
    </>
  );
}

function AnimatedLoopSystem() {
  return (
    <div className="keeps-animation-shell" aria-label="Forward or CC Keeps to turn email into company intelligence">
      <svg
        className="keeps-workflow-svg"
        fill="none"
        role="img"
        viewBox="0 0 820 690"
        xmlns="http://www.w3.org/2000/svg"
      >
        <title>Keeps company intelligence workflow</title>
        <desc>A chosen work email highlights CC keeps@keeps.email, then becomes source-backed memory, reminders, and approval-ready actions.</desc>
        <defs>
          <pattern id="keeps-grid" width="42" height="42" patternUnits="userSpaceOnUse">
            <path d="M42 0H0V42" stroke="rgba(30,107,79,.12)" strokeWidth="1" />
          </pattern>
          <linearGradient id="keeps-green-wash" x1="70" x2="760" y1="70" y2="620">
            <stop stopColor="#C1F5DF" stopOpacity=".9" />
            <stop offset=".55" stopColor="#E9FBF4" stopOpacity=".72" />
            <stop offset="1" stopColor="#1E6B4F" stopOpacity=".18" />
          </linearGradient>
          <marker id="keeps-arrow" markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4">
            <path d="M0 0L8 4L0 8Z" fill="#1E6B4F" />
          </marker>
          <filter id="soft-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="18" stdDeviation="24" floodColor="#1E6B4F" floodOpacity=".16" />
          </filter>
        </defs>

        <rect className="keeps-svg-bg" x="18" y="18" width="784" height="654" rx="4" />
        <rect x="18" y="18" width="784" height="654" rx="4" fill="url(#keeps-grid)" />
        <rect className="keeps-svg-wash" x="48" y="48" width="724" height="594" rx="4" />

        <g className="keeps-faint-card keeps-faint-card-one">
          <rect x="92" y="76" width="232" height="112" rx="4" fill="#FAFAF8" stroke="#DDE4DF" />
          <text className="keeps-svg-label" x="114" y="108">source thread</text>
          <path d="M114 132H282" stroke="#C8D8D0" strokeWidth="5" />
          <path d="M114 158H252" stroke="#E5ECE7" strokeWidth="5" />
        </g>
        <g className="keeps-faint-card keeps-faint-card-two">
          <rect x="540" y="70" width="190" height="102" rx="4" fill="#FAFAF8" stroke="#DDE4DF" />
          <text className="keeps-svg-label" x="560" y="102">approval gate</text>
          <rect x="560" y="124" width="64" height="24" rx="3" fill="#C1F5DF" />
          <path d="M638 134H704" stroke="#C8D8D0" strokeWidth="4" />
        </g>
        <g className="keeps-faint-card keeps-faint-card-three">
          <rect x="438" y="508" width="250" height="92" rx="4" fill="#FAFAF8" stroke="#DDE4DF" />
          <text className="keeps-svg-label" x="460" y="540">source quote</text>
          <path d="M460 562H642" stroke="#D9E7DF" strokeWidth="5" />
          <path d="M460 584H602" stroke="#E5ECE7" strokeWidth="5" />
        </g>

        <g className="keeps-source-panel" filter="url(#soft-shadow)">
          <rect x="64" y="144" width="304" height="286" rx="4" fill="#FAFAF8" stroke="#14140F" strokeOpacity=".24" strokeWidth="1.5" />
          <rect x="64" y="144" width="304" height="40" rx="4" fill="#14140F" />
          <text className="keeps-svg-label keeps-svg-label-light" x="86" y="170">01 / permissioned capture</text>
          <circle cx="340" cy="164" r="5" fill="#C1F5DF" />

          <text className="keeps-svg-label" x="88" y="216">To</text>
          <text className="keeps-svg-small keeps-svg-dark" x="142" y="216">Priya Nair</text>
          <path d="M88 236H344" stroke="#DDE4DF" strokeWidth="1.5" />

          <text className="keeps-svg-label" x="88" y="268">Cc</text>
          <rect className="keeps-cc-chip" x="142" y="244" width="182" height="30" rx="4" fill="#C1F5DF" stroke="#1E6B4F" strokeWidth="1.25" />
          <text className="keeps-svg-chip-text keeps-email-address" x="156" y="264">keeps@keeps.email</text>
          <path d="M88 292H344" stroke="#DDE4DF" strokeWidth="1.5" />

          <text className="keeps-svg-label" x="88" y="324">Subject</text>
          <text className="keeps-svg-small keeps-svg-dark" x="164" y="324">Security review + trial</text>
          <path d="M88 344H344" stroke="#DDE4DF" strokeWidth="1.5" />

          <text className="keeps-svg-small keeps-svg-dark" x="88" y="376">Can you send these before Friday?</text>
          <path d="M88 402H304" stroke="#C8D8D0" strokeWidth="5" />
          <path d="M88 420H258" stroke="#E5ECE7" strokeWidth="5" />
        </g>

        <path className="keeps-flow-line keeps-flow-line-one" d="M322 258C354 250 374 248 406 258" markerEnd="url(#keeps-arrow)" />

        <g className="keeps-trace-panel" filter="url(#soft-shadow)">
          <rect x="388" y="122" width="364" height="374" rx="4" fill="#FAFAF8" stroke="#14140F" strokeOpacity=".26" strokeWidth="1.5" />
          <rect x="408" y="146" width="32" height="32" rx="4" fill="#C1F5DF" stroke="#1E6B4F" />
          <path d="M418 162H430" stroke="#1E6B4F" strokeWidth="2" />
          <path d="M424 156V168" stroke="#1E6B4F" strokeWidth="2" />
          <text className="keeps-svg-title keeps-trace-title" x="454" y="168">Keeps Trace</text>
          <text className="keeps-svg-label" x="454" y="190">from chosen email</text>

          <g className="keeps-trace-step keeps-trace-step-one">
            <rect x="408" y="214" width="324" height="50" rx="4" fill="#F6F8F5" stroke="#DDE4DF" />
            <text className="keeps-svg-chip-text" x="424" y="244">1.</text>
            <text className="keeps-svg-small keeps-svg-dark" x="454" y="238">Read chosen source thread</text>
            <text className="keeps-svg-note" x="454" y="256">permissioned capture</text>
          </g>
          <g className="keeps-trace-step keeps-trace-step-two">
            <rect x="408" y="274" width="324" height="58" rx="4" fill="#E9FBF4" stroke="#1E6B4F" strokeWidth="1.5" />
            <text className="keeps-svg-chip-text" x="424" y="308">2.</text>
            <text className="keeps-svg-small keeps-svg-dark" x="454" y="302">Extract 3 open loops</text>
            <text className="keeps-svg-note" x="454" y="320">owner, due date, next action</text>
          </g>
          <g className="keeps-trace-step keeps-trace-step-three">
            <rect x="408" y="342" width="324" height="50" rx="4" fill="#F6F8F5" stroke="#DDE4DF" />
            <text className="keeps-svg-chip-text" x="424" y="372">3.</text>
            <text className="keeps-svg-small keeps-svg-dark" x="454" y="366">Schedule Friday nudge</text>
            <text className="keeps-svg-note" x="454" y="384">before the trial seat deadline</text>
          </g>
          <g className="keeps-trace-step keeps-trace-step-four">
            <rect x="408" y="402" width="324" height="50" rx="4" fill="#F6F8F5" stroke="#DDE4DF" />
            <text className="keeps-svg-chip-text" x="424" y="432">4.</text>
            <text className="keeps-svg-small keeps-svg-dark" x="454" y="426">Hold draft for approval</text>
            <text className="keeps-svg-note" x="454" y="444">send only after okay</text>
          </g>

          <g className="keeps-status-row">
            <rect className="keeps-status-line" x="408" y="464" width="324" height="22" rx="3" fill="#14140F" />
            <text className="keeps-svg-chip-text keeps-svg-label-light" x="422" y="479">Building intelligence: 3 loops found</text>
          </g>
        </g>

        <path className="keeps-flow-line keeps-flow-line-two" d="M520 496C460 530 376 544 294 540" markerEnd="url(#keeps-arrow)" />
        <path className="keeps-flow-line keeps-flow-line-three" d="M634 496C628 518 622 534 612 552" markerEnd="url(#keeps-arrow)" />

        <g className="keeps-output-card keeps-output-one">
          <rect x="76" y="480" width="224" height="112" rx="4" fill="#FAFAF8" stroke="#14140F" strokeOpacity=".24" strokeWidth="1.5" />
          <text className="keeps-svg-label" x="98" y="512">nudge queue</text>
          <text className="keeps-svg-title keeps-output-title" x="98" y="546">Friday 9 AM</text>
          <rect x="98" y="562" width="58" height="18" rx="3" fill="#C1F5DF" />
          <text className="keeps-svg-chip-text" x="111" y="575">ready</text>
        </g>

        <g className="keeps-output-card keeps-output-two">
          <rect x="510" y="520" width="224" height="82" rx="4" fill="#14140F" />
          <text className="keeps-svg-label keeps-svg-label-light" x="532" y="550">approval draft</text>
          <path d="M532 572H624" stroke="#F5F5F4" strokeOpacity=".42" strokeWidth="4" />
          <rect x="654" y="554" width="56" height="28" rx="3" fill="#C1F5DF" />
          <text className="keeps-svg-chip-text" x="666" y="573">review</text>
        </g>

        <circle className="keeps-packet keeps-packet-one" r="5" />
        <circle className="keeps-packet keeps-packet-two" r="5" />
        <circle className="keeps-packet keeps-packet-three" r="5" />
      </svg>
      <div className="keeps-visual-caption">
        <span>Forwarded email becomes operational intelligence</span>
        <strong>Operational intelligence</strong>
      </div>
    </div>
  );
}

function LoopConsole() {
  return (
    <Card className="keeps-console-card">
      <div className="keeps-console-head">
        <span className="keeps-console-kicker">From chosen email</span>
        <strong>Captured intelligence you can act on</strong>
      </div>
      <div className="keeps-loop-list">
        {loops.map((loop, index) => (
          <article className="keeps-loop-row" key={loop.summary}>
            <span className="keeps-loop-index">0{index + 1}</span>
            <div>
              <p>{loop.summary}</p>
              <small>{loop.source}</small>
            </div>
            <mark>{loop.status}</mark>
            <time>{loop.time}</time>
          </article>
        ))}
      </div>
    </Card>
  );
}

function Hero() {
  return (
    <>
      <Section className="keeps-hero-section">
        <div className="keeps-hero-grid">
          <div className="keeps-hero-left">
            <Card className="keeps-hero-copy-card" dots={false}>
              <p className="keeps-eyebrow">For agentic teams</p>
              <h1>
                Company
                <br />
                intelligence,
                <br />
                captured.
              </h1>
              <p className="keeps-hero-copy">
                Keeps turns the emails you forward, CC, or send into a private learning
                loop for your company: open loops, reminders, approvals, and agent-ready
                context, without giving an agent access to everything.
              </p>
            </Card>
            <Card className="keeps-hero-action-card">
              <Link className="keeps-button keeps-button-primary" href={"/get-started" as Route}>
                Get started
              </Link>
              <p>Start with reminders and follow-ups. Build toward company memory your agents can use.</p>
            </Card>
          </div>
          <Card className="keeps-hero-visual-card" dots={false}>
            <AnimatedLoopSystem />
          </Card>
        </div>
      </Section>
      <Section className="keeps-console-section">
        <LoopConsole />
      </Section>
    </>
  );
}

function Workflow() {
  return (
    <Section className="keeps-workflow-section">
      <div id="how" className="keeps-workflow-grid">
        {workflowSteps.map((step) => (
          <Card className="keeps-step-card" key={step.eyebrow}>
            <p>{step.eyebrow}</p>
            <h2>{step.title}</h2>
            <span>{step.body}</span>
          </Card>
        ))}
      </div>
    </Section>
  );
}

function ControlSection() {
  return (
    <Section className="keeps-control-section">
      <div className="keeps-control-grid">
        <Card className="keeps-control-copy" dots={false}>
          <p className="keeps-eyebrow">03 / Control</p>
          <h2>Private intelligence. Explicit action.</h2>
          <p>
            Keeps helps your company compound what people already know while keeping
            capture permissioned and actions approval-gated.
          </p>
        </Card>
        <Card className="keeps-control-panel">
          <div className="keeps-control-panel-head">
            <span>Control ledger</span>
            <strong>What Keeps is allowed to do</strong>
          </div>
          <div className="keeps-control-list">
            {controlItems.map((item) => (
              <article className="keeps-control-row" key={item.number}>
                <span>{item.number}</span>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.body}</p>
                </div>
              </article>
            ))}
          </div>
        </Card>
      </div>
    </Section>
  );
}

function Footer() {
  return (
    <footer className="keeps-footer">
      <div className="keeps-side" />
      <div className="keeps-footer-inner">
        <KeepsMark />
        <span>Frictionless company intelligence for agentic teams.</span>
      </div>
      <div className="keeps-side" />
    </footer>
  );
}

export function KeepsLanding() {
  return (
    <div className="keeps-page">
      <Header />
      <main>
        <Hero />
        <Workflow />
        <ControlSection />
      </main>
      <Footer />
    </div>
  );
}
