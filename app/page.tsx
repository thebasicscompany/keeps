import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import type { Route } from "next";
import DotField from "./components/dot-field";

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------

const primaryButtonClass =
  "h-16 rounded-none border border-[rgba(30,107,79,0.32)] bg-[#C1F5DF] px-6 text-base font-semibold text-[#14140F] shadow-[inset_0_1px_0_rgba(255,255,255,0.75),inset_0_-2px_0_rgba(30,107,79,0.28),0_12px_24px_rgba(30,107,79,0.16)] transition-colors hover:bg-[#AFF0D3] focus-visible:ring-2 focus-visible:ring-[rgba(30,107,79,0.32)] focus-visible:outline-none";

// ---------------------------------------------------------------------------
// Auth helper — resolves whether the visitor is signed in (best-effort;
// never throws on misconfigured Clerk)
// ---------------------------------------------------------------------------

async function isSignedIn(): Promise<boolean> {
  try {
    const { userId } = await auth();
    return !!userId;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function LandingPage() {
  const signedIn = await isSignedIn();

  return (
    <>
      {/* Full-bleed dot-field background */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 bg-[#FAFAF8]"
      >
        <DotField
          dotRadius={1.5}
          dotSpacing={14}
          bulgeStrength={67}
          glowRadius={0}
          sparkle={false}
          waveAmplitude={0}
          gradientFrom="rgba(20,20,15,0.32)"
          gradientTo="rgba(20,20,15,0.20)"
          glowColor="transparent"
          className="absolute inset-0 h-full w-full"
        />
      </div>

      <div className="relative z-10 min-h-svh text-[#14140F]">
        {/* ------------------------------------------------------------------ */}
        {/* Top bar                                                             */}
        {/* ------------------------------------------------------------------ */}
        <header className="mx-auto flex w-full max-w-[960px] items-center justify-between px-5 pt-7 pb-6 sm:px-8">
          <span className="font-bricolage text-[22px] font-bold tracking-tight text-[#14140F]">
            Keeps
          </span>
          <Link
            href={"/sign-in" as Route}
            className="text-sm font-medium text-[#6F6F66] transition-colors hover:text-[#14140F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#14140F]/20"
          >
            Sign in
          </Link>
        </header>

        {/* ------------------------------------------------------------------ */}
        {/* Hero                                                                */}
        {/* ------------------------------------------------------------------ */}
        <section className="mx-auto flex w-full max-w-[720px] flex-col items-center px-5 pt-16 pb-20 text-center sm:px-8 sm:pt-24 sm:pb-28">
          <h1 className="text-[40px] font-bold leading-[1.1] tracking-tight text-[#14140F] sm:text-[56px]">
            Forward it.
            <br />
            Keeps remembers.
          </h1>
          <p className="mt-6 max-w-[560px] text-[17px] font-medium leading-[1.7] text-[#6F6F66] sm:text-[18px]">
            Email Keeps, forward a thread, or CC it once. It pulls out what you
            committed to and what you&apos;re waiting on, nudges you before things slip,
            and — only with your okay — sends the Slack message or books the time.
          </p>
          <Link
            href={"/get-started" as Route}
            className={`${primaryButtonClass} mt-10 inline-flex items-center justify-center px-10`}
          >
            {signedIn ? "Continue setup" : "Get started"}
          </Link>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* How it works                                                        */}
        {/* ------------------------------------------------------------------ */}
        <section className="mx-auto w-full max-w-[960px] px-5 pb-20 sm:px-8 sm:pb-28">
          <div className="border border-[#E2E2DD] bg-white shadow-[0_4px_24px_rgba(20,20,15,0.05)]">
            <div className="grid grid-cols-1 divide-y divide-[#E2E2DD] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              {/* Step 1 */}
              <div className="px-7 py-8">
                <div className="mb-4 flex size-9 items-center justify-center bg-[#14140F] text-[#C1F5DF]">
                  <span className="text-sm font-bold">1</span>
                </div>
                <h3 className="mb-2 text-[17px] font-bold text-[#14140F]">Capture</h3>
                <p className="text-[15px] font-medium leading-[1.65] text-[#6F6F66]">
                  Forward, CC, or just email it.
                </p>
              </div>

              {/* Step 2 */}
              <div className="px-7 py-8">
                <div className="mb-4 flex size-9 items-center justify-center bg-[#14140F] text-[#C1F5DF]">
                  <span className="text-sm font-bold">2</span>
                </div>
                <h3 className="mb-2 text-[17px] font-bold text-[#14140F]">Track &amp; nudge</h3>
                <p className="text-[15px] font-medium leading-[1.65] text-[#6F6F66]">
                  It surfaces your open loops and pokes you before they slip.
                </p>
              </div>

              {/* Step 3 */}
              <div className="px-7 py-8">
                <div className="mb-4 flex size-9 items-center justify-center bg-[#14140F] text-[#C1F5DF]">
                  <span className="text-sm font-bold">3</span>
                </div>
                <h3 className="mb-2 text-[17px] font-bold text-[#14140F]">Act</h3>
                <p className="text-[15px] font-medium leading-[1.65] text-[#6F6F66]">
                  Approve, and it sends the Slack DM or books the time. Nothing
                  leaves without your okay.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Trust line                                                          */}
        {/* ------------------------------------------------------------------ */}
        <section className="mx-auto w-full max-w-[960px] px-5 pb-20 sm:px-8 sm:pb-28">
          <div className="border border-[rgba(30,107,79,0.22)] bg-[#E9FBF4] px-7 py-6">
            <p className="text-[15px] font-medium leading-[1.7] text-[#1E6B4F]">
              <span className="font-bold text-[#14140F]">Explicit capture.</span>{" "}
              Keeps only sees what you send it — never your whole inbox.
            </p>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Footer                                                              */}
        {/* ------------------------------------------------------------------ */}
        <footer className="mx-auto flex w-full max-w-[960px] items-center justify-between border-t border-[#E2E2DD] px-5 py-7 sm:px-8">
          <span className="text-[15px] font-bold text-[#14140F]">Keeps</span>
          <span className="text-[13px] font-medium text-[#6F6F66]">
            Private by default.
          </span>
        </footer>
      </div>
    </>
  );
}
