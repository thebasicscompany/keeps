import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import type { Route } from "next";

// ---------------------------------------------------------------------------
// Keeps design tokens
// ---------------------------------------------------------------------------

const primaryButtonClass =
  "inline-flex h-16 items-center justify-center rounded-none border border-[rgba(30,107,79,0.32)] bg-[#C1F5DF] px-10 text-base font-semibold text-[#14140F] shadow-[inset_0_1px_0_rgba(255,255,255,0.75),inset_0_-2px_0_rgba(30,107,79,0.28),0_12px_24px_rgba(30,107,79,0.16)] transition-colors hover:bg-[#AFF0D3] focus-visible:ring-2 focus-visible:ring-[rgba(30,107,79,0.32)] focus-visible:outline-none";
const approveButtonClass =
  "inline-flex h-10 items-center justify-center rounded-none border border-[rgba(30,107,79,0.4)] bg-[#C1F5DF] px-4 text-[13px] font-semibold text-[#14140F] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] transition-colors hover:bg-[#AFF0D3]";
const denyButtonClass =
  "inline-flex h-10 items-center justify-center rounded-none border border-[rgba(20,20,15,0.22)] bg-white/70 px-4 text-[13px] font-semibold text-[#14140F]";

const GMAIL_FONT = "'Roboto','Helvetica Neue',Arial,sans-serif";

async function isSignedIn(): Promise<boolean> {
  try {
    const { userId } = await auth();
    return !!userId;
  } catch {
    return false;
  }
}

function GIcon({ d, className = "size-[18px]" }: { d: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Hero graphic: a real Gmail-style email (read view, no chrome), with a
// glassmorphic frosted KEEPS panel superimposed — Keeps-styled (seafoam) buttons.
// ---------------------------------------------------------------------------

function EmailWithKeeps() {
  return (
    <div className="relative w-[min(92vw,540px)]">
      {/* ---- The email (Gmail read view) -------------------------------- */}
      <div
        className="max-h-[80vh] overflow-hidden rounded-[14px] border border-[#e8eaed] bg-white pb-4 shadow-[0_30px_90px_rgba(20,20,15,0.18)]"
        style={{ fontFamily: GMAIL_FONT }}
      >
        {/* sender row */}
        <div className="flex items-start gap-3 px-6 pt-6">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#1e7d5a] text-[16px] font-medium text-white">
            P
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-bold text-[#202124]">Priya Nair</span>
              <span className="ml-auto flex items-center gap-3 text-[#5f6368]">
                <span className="hidden text-[12px] sm:inline">2:14 PM (3 hours ago)</span>
                <GIcon d="M12 2l3 7 7 .5-5.5 4.5 2 7-6.5-4-6.5 4 2-7L2 9.5l7-.5z" className="size-[16px]" />
                <GIcon d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" className="size-[16px]" />
                <GIcon d="M9 14l-4-4 4-4M5 10h7a4 4 0 0 1 4 4v3" className="size-[16px]" />
                <GIcon d="M12 5h.01M12 12h.01M12 19h.01" className="size-[16px]" />
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[13px] text-[#5f6368]">
              to me, Jordan, Dana
              <GIcon d="M6 9l6 6 6-6" className="size-3.5" />
            </div>
          </div>
        </div>

        {/* body */}
        <div className="px-6 pt-5 pl-[64px] text-[14px] leading-[1.7] text-[#202124]">
          <p>Hi —</p>
          <p className="mt-4">
            Really enjoyed the demo, the team&apos;s sold. A few things to get this moving
            on our side:
          </p>
          <ol className="mt-4 ml-5 list-decimal space-y-2.5">
            <li>
              Could you send over your <span className="font-bold">SOC 2 report</span> and
              security questionnaire? Procurement won&apos;t start without them.
            </li>
            <li>
              We&apos;d love a two-week trial for <span className="font-bold">5 seats</span> —
              any chance you can spin that up?
            </li>
            <li>
              I&apos;ll get budget sign-off from Dana by{" "}
              <span className="font-bold">Friday</span> and come back with a redlined contract.
            </li>
          </ol>
          <p className="mt-4 text-[#5f6368]">Thanks!</p>
          <p className="text-[#5f6368]">Priya</p>
          <p className="mt-5 text-[#80868b]">--</p>
          <p className="mt-3">
            <span className="font-bold text-[#202124]">Priya Nair</span>
            <span className="text-[#5f6368]"> · Head of Ops, Acme</span>
          </p>
          <p className="mt-1 text-[#1a73e8] underline">acme.com · LinkedIn</p>
        </div>
      </div>

      {/* ---- Keeps — simple floating action card on top of the email ---- */}
      <div className="absolute inset-x-4 bottom-4 border border-black/[0.06] bg-gradient-to-b from-white to-[#fbfbfa] px-4 py-4 shadow-[0_22px_55px_rgba(20,20,15,0.3)] ring-1 ring-black/[0.04]">
        <div className="flex items-center gap-2">
          <span className="size-2.5 bg-[#1E6B4F]" />
          <span className="text-[13px] font-bold text-[#14140F]">Keeps</span>
          <span className="text-[13px] font-medium text-[#5b655f]">caught 3 loops</span>
          <span className="ml-auto text-[12px] font-semibold text-[#5b655f]">nudge me Fri</span>
        </div>
        <div className="mt-3 flex items-center gap-2.5">
          <span className={approveButtonClass}>Track all 3</span>
          <span className={denyButtonClass}>Edit</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function LandingPage() {
  const signedIn = await isSignedIn();

  return (
    <div className="min-h-svh bg-[#FAFAF8] text-[#14140F]">
      {/* Top bar */}
      <header className="mx-auto flex w-full max-w-[1180px] items-center justify-between px-6 pt-7 pb-2 sm:px-10">
        <span className="text-[22px] font-bold tracking-tight text-[#14140F]">Keeps</span>
        <Link
          href={"/sign-in" as Route}
          className="text-sm font-medium text-[#6F6F66] transition-colors hover:text-[#14140F]"
        >
          Sign in
        </Link>
      </header>

      {/* HERO — text + CTA down the left, the email+frosted-Keeps graphic right */}
      <section className="mx-auto grid w-full max-w-[1180px] grid-cols-1 gap-14 px-6 pt-10 pb-16 sm:px-10 lg:min-h-[calc(100svh-96px)] lg:grid-cols-[minmax(0,46%)_minmax(0,54%)] lg:gap-6 lg:pb-10">
        {/* LEFT */}
        <div className="flex flex-col lg:py-6">
          <div>
            <p className="text-[17px] font-semibold text-[#1E6B4F]">
              For founders &amp; operators
            </p>
            <h1 className="mt-4 text-[44px] font-bold leading-[1.04] tracking-tight text-[#14140F] sm:text-[60px] lg:text-[68px]">
              Forward it.
              <br />
              Keeps remembers.
            </h1>
            <p className="mt-7 max-w-[460px] text-[18px] leading-[1.6] font-medium text-[#6F6F66]">
              Email it your work. Keeps pulls out every loop you open, nudges you
              before things slip, and — only with your okay — gets them done.
            </p>
          </div>

          <div className="mt-12 lg:mt-auto lg:pt-12">
            <Link href={"/get-started" as Route} className={primaryButtonClass}>
              {signedIn ? "Continue setup" : "Get started"}
            </Link>
            <p className="mt-5 text-[14px] font-medium text-[#6F6F66]">
              Explicit capture — Keeps only ever sees what you send it.
            </p>
          </div>
        </div>

        {/* RIGHT — tilted + bleeding right (simple floating card, no backdrop glass) */}
        <div className="relative hidden lg:flex lg:items-center lg:justify-end">
          <div className="mr-[-44px] rotate-[-3deg]">
            <EmailWithKeeps />
          </div>
        </div>

        {/* Mobile/tablet — flat, below the text */}
        <div className="flex justify-center pb-6 lg:hidden">
          <EmailWithKeeps />
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto w-full max-w-[1180px] px-6 pb-20 sm:px-10">
        <div className="border border-[#E2E2DD] bg-white shadow-[0_4px_24px_rgba(20,20,15,0.05)]">
          <div className="grid grid-cols-1 divide-y divide-[#E2E2DD] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {[
              { n: "1", title: "Capture", body: "Forward, CC, or just email it." },
              {
                n: "2",
                title: "Track & nudge",
                body: "It surfaces your open loops and pokes you before they slip.",
              },
              {
                n: "3",
                title: "Act",
                body: "Approve, and it sends the Slack DM or books the time. Nothing leaves without your okay.",
              },
            ].map((step) => (
              <div key={step.n} className="px-7 py-8">
                <div className="mb-4 flex size-9 items-center justify-center bg-[#14140F] text-[#C1F5DF]">
                  <span className="text-sm font-bold">{step.n}</span>
                </div>
                <h3 className="mb-2 text-[17px] font-bold text-[#14140F]">{step.title}</h3>
                <p className="text-[15px] leading-[1.65] font-medium text-[#6F6F66]">
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="mx-auto flex w-full max-w-[1180px] items-center justify-between border-t border-[#E2E2DD] px-6 py-7 sm:px-10">
        <span className="text-[15px] font-bold text-[#14140F]">Keeps</span>
        <span className="text-[13px] font-medium text-[#6F6F66]">Private by default.</span>
      </footer>
    </div>
  );
}
