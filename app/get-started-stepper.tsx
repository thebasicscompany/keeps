"use client";

import { useSignUp } from "@clerk/nextjs/legacy";
import { isClerkAPIResponseError } from "@clerk/nextjs/errors";
import { Archive, ArrowRight, Check, Copy, Mail, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CAPTURE_ADDRESS } from "@/product/capture-address";
import { workingStyles } from "@/product/working-styles";
import { cn } from "@/lib/utils";
import { WorkingStylePicker } from "./working-style-picker";

// The "code" step is a sub-state of the email step in the progress bar: proving
// you own the email (enter address -> enter code) is one logical phase, so it
// keeps the email dot lit and leaves the bar at 3 stable dots on a 390px screen.
type StepId = "email" | "code" | "capture" | "style" | "done";

const steps: StepId[] = ["email", "capture", "style"];
const RESEND_COOLDOWN_SECONDS = 30;

const primaryButtonClass =
  "h-16 rounded-[22px] border border-[#944023]/25 bg-[#bf5636] bg-linear-to-b from-white/18 to-black/8 px-6 text-base font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.28),inset_0_-1px_0_rgb(91_35_17/0.34),0_14px_28px_rgb(125_55_28/0.2)] transition-colors hover:bg-[#ad492d] focus-visible:ring-2 focus-visible:ring-[#bf5636]/32 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-[#bf5636]";

const inputClass =
  "h-[78px] w-full rounded-[25px] border border-[#e6dacd] bg-[#fffaf3]/82 px-7 text-[18px] font-medium text-[#171310] shadow-[inset_0_1px_0_rgb(255_255_255/0.68)] outline-none transition-colors placeholder:text-[#9d948b] focus:border-[#d4c1b1] focus:bg-[#fffaf3] focus:ring-0";

// Maps a thrown Clerk error to a single inline message in the design language.
// Never renders raw error objects. `existing` signals the caller to surface the
// sign-in link rather than a plain message.
function describeClerkError(error: unknown): { message: string; existing: boolean } {
  if (isClerkAPIResponseError(error)) {
    const first = error.errors[0];
    const code = first?.code;

    switch (code) {
      case "form_identifier_exists":
      case "identifier_already_signed_in":
        return {
          message: "That email already has a Keeps account.",
          existing: true,
        };
      case "form_param_format_invalid":
      case "form_param_nil":
      case "form_identifier_not_found":
        return { message: "That doesn't look like a valid email address.", existing: false };
      case "form_code_incorrect":
      case "verification_failed":
        return { message: "That code isn't right. Check it and try again.", existing: false };
      case "verification_expired":
        return { message: "That code expired. Send a fresh one and try again.", existing: false };
      case "too_many_requests":
      case "rate_limit_exceeded":
        return { message: "Too many attempts. Wait a moment, then try again.", existing: false };
      default:
        return {
          message: first?.longMessage ?? first?.message ?? "Something went wrong. Please try again.",
          existing: false,
        };
    }
  }

  return { message: "Something went wrong. Please try again.", existing: false };
}

export function GetStartedStepper({ sessionEmail }: { sessionEmail: string | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const clerk = useSignUp();
  const isLoaded = clerk.isLoaded;

  const queryEmail = searchParams.get("email_address") ?? "";

  const [step, setStep] = useState<StepId>(sessionEmail ? "capture" : "email");
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState(sessionEmail ?? queryEmail);

  // Inline sign-up state.
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; existing: boolean } | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const codeInputRef = useRef<HTMLInputElement>(null);

  // Synchronous in-flight guard — prevents parallel Clerk calls when the
  // auto-submit (6th digit) and Verify button fire in the same event loop tick.
  // React state (`submitting`) is async and re-renders too late for this.
  const inFlightRef = useRef(false);

  // The last code value that was auto-submitted via onCodeChange, so we never
  // fire a second auto-submit for the same value (e.g. re-render after error).
  const lastAutoSubmitRef = useRef<string>("");

  // Resend cooldown ticker.
  useEffect(() => {
    if (cooldown <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setCooldown((value) => (value <= 1 ? 0 : value - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  // Focus the code input when entering the code step.
  useEffect(() => {
    if (step === "code") {
      codeInputRef.current?.focus();
    }
  }, [step]);

  const stepIndex = useMemo(() => {
    if (step === "done") {
      return steps.length;
    }
    // "code" is part of the email phase, so it lights the first dot.
    if (step === "code") {
      return 0;
    }
    return Math.max(0, steps.indexOf(step));
  }, [step]);

  function copyAddress() {
    void navigator.clipboard?.writeText(CAPTURE_ADDRESS);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  // Shared success path for both normal verification and "already verified"
  // recovery. Factored out so submitCode's catch can reuse it without
  // duplicating the setActive + refresh + setStep sequence. A missing session
  // id means the sign-up is NOT actually complete (e.g. the instance demands a
  // field this flow never collects) — advancing would fake success with no
  // Clerk user behind it, which is how the password-requirement outage hid.
  async function completeVerification(sessionId: string | null | undefined): Promise<boolean> {
    if (!clerk.isLoaded || !sessionId) {
      setError({
        message: "Verification didn't finish. Send a fresh code and try again.",
        existing: false,
      });
      return false;
    }
    await clerk.setActive({ session: sessionId });
    router.refresh();
    setStep("capture");
    return true;
  }

  async function startSignUp(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!clerk.isLoaded || inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    const { signUp } = clerk;

    const trimmed = email.trim();
    if (!trimmed) {
      inFlightRef.current = false;
      setError({ message: "Enter your work email to continue.", existing: false });
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await signUp.create({ emailAddress: trimmed });
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setEmail(trimmed);
      setCode("");
      lastAutoSubmitRef.current = "";
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setStep("code");
    } catch (caught) {
      setError(describeClerkError(caught));
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }

  async function submitCode(rawCode: string) {
    // Part 1: synchronous in-flight guard — blocks a second parallel call that
    // races through before React re-renders the `submitting` state.
    if (!clerk.isLoaded || inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    const { signUp } = clerk;

    const trimmed = rawCode.trim();
    if (trimmed.length !== 6) {
      inFlightRef.current = false;
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const attempt = await signUp.attemptEmailAddressVerification({ code: trimmed });

      if (attempt.status === "complete") {
        // The capture/style steps and app/page.tsx read the signed-in session,
        // so refresh router state before advancing in place.
        await completeVerification(attempt.createdSessionId);
        return;
      }

      // Any non-complete status (e.g. missing requirements) is unexpected here.
      setError({
        message: "Couldn't finish verifying. Send a fresh code and try again.",
        existing: false,
      });
    } catch (caught) {
      // Part 2: recover from "already verified" race. If the first of two
      // parallel calls already succeeded server-side, Clerk returns
      // "verification_already_verified". Treat that — or a signUp already
      // showing complete — as success rather than an error.
      if (
        isClerkAPIResponseError(caught) &&
        caught.errors.some((e) => e.code === "verification_already_verified")
      ) {
        await completeVerification(clerk.signUp?.createdSessionId);
        return;
      }
      if (clerk.signUp?.status === "complete") {
        await completeVerification(clerk.signUp.createdSessionId);
        return;
      }
      setError(describeClerkError(caught));
      setCode("");
      lastAutoSubmitRef.current = "";
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }

  function onCodeFormSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitCode(code);
  }

  function onCodeChange(event: React.ChangeEvent<HTMLInputElement>) {
    const digits = event.target.value.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (error) {
      setError(null);
    }
    // Part 3: only auto-submit if this is a new 6-digit value — prevents a
    // second auto-submit for the same code on re-render after error clear.
    if (digits.length === 6 && digits !== lastAutoSubmitRef.current) {
      lastAutoSubmitRef.current = digits;
      void submitCode(digits);
    }
  }

  async function resendCode() {
    if (!clerk.isLoaded || inFlightRef.current || cooldown > 0) {
      return;
    }
    inFlightRef.current = true;
    const { signUp } = clerk;
    setError(null);
    try {
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (caught) {
      setError(describeClerkError(caught));
    } finally {
      inFlightRef.current = false;
    }
  }

  function goBack() {
    setError(null);
    if (step === "style") {
      setStep("capture");
    } else if (step === "capture") {
      setStep(sessionEmail ? "capture" : "email");
    } else if (step === "code") {
      setCode("");
      setStep("email");
    } else {
      setStep("email");
    }
  }

  return (
    <main className="min-h-svh bg-[#fbf7f0] text-[#171310]">
      <section className="mx-auto flex min-h-svh w-full max-w-[546px] flex-col justify-center px-5 py-9 sm:px-0">
        <div className="rounded-[34px] border border-[#efe5da]/72 bg-linear-to-b from-white/58 to-white/16 p-5 shadow-[inset_0_1px_0_rgb(255_255_255/0.8),0_28px_80px_rgb(84_48_24/0.08)] sm:p-6">
          <div className="mb-9 flex items-start justify-between gap-6">
            <div className="min-w-0">
              <div
                className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-[#bf5636] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.24),0_10px_28px_rgb(120_55_28/0.12)]"
                aria-hidden="true"
              >
                {step === "email" ? (
                  <Archive className="size-7" strokeWidth={2.6} />
                ) : step === "code" ? (
                  <ShieldCheck className="size-7" strokeWidth={2.4} />
                ) : (
                  <Mail className="size-7" strokeWidth={2.4} />
                )}
              </div>
              <h1 className="text-[28px] leading-tight font-medium tracking-normal text-[#171310]">
                Welcome to Keeps
              </h1>
              <p className="mt-1 text-[27px] leading-tight font-medium tracking-normal text-[#9a9086]">
                {step === "email" && "What's your work email?"}
                {step === "code" && "Enter your code."}
                {step === "capture" && "Save your capture address."}
                {step === "style" && "How should Keeps write?"}
                {step === "done" && "You're ready."}
              </p>
            </div>

            {step !== "done" ? (
              <button
                className="mt-5 shrink-0 text-sm font-medium text-[#8e8378] transition-colors hover:text-[#171310] focus-visible:ring-2 focus-visible:ring-[#171310]/20 focus-visible:outline-none"
                onClick={() => setStep("done")}
                type="button"
              >
                Set up later
              </button>
            ) : null}
          </div>

          <div className="min-h-[128px]">
            {step === "email" ? (
              <form className="space-y-5" id="keeps-email-form" onSubmit={startSignUp}>
                <label className="sr-only" htmlFor="email">
                  Work email
                </label>
                <input
                  id="email"
                  name="email"
                  placeholder="you@company.com"
                  autoComplete="email"
                  type="email"
                  required
                  className={inputClass}
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    if (error) {
                      setError(null);
                    }
                  }}
                />
                {/* Clerk smart bot protection mounts here; without it signUp.create
                    fails on instances with bot protection enabled. */}
                <div id="clerk-captcha" />
                {error ? (
                  <p className="px-1 text-sm leading-6 font-medium text-[#bf5636]">
                    {error.message}
                    {error.existing ? (
                      <>
                        {" "}
                        <Link
                          className="font-semibold underline underline-offset-2 hover:text-[#ad492d]"
                          href={"/sign-in" as Route}
                        >
                          Sign in instead
                        </Link>
                        .
                      </>
                    ) : null}
                  </p>
                ) : (
                  <p className="px-1 text-sm leading-6 font-medium text-[#7d7167]">
                    Keeps only accepts messages from an address you verify.
                  </p>
                )}
              </form>
            ) : null}

            {step === "code" ? (
              <form className="space-y-5" id="keeps-code-form" onSubmit={onCodeFormSubmit}>
                <label className="sr-only" htmlFor="code">
                  Verification code
                </label>
                <input
                  id="code"
                  name="code"
                  ref={codeInputRef}
                  placeholder="000000"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  type="text"
                  maxLength={6}
                  required
                  className={cn(inputClass, "text-center font-mono tracking-[0.45em]")}
                  value={code}
                  onChange={onCodeChange}
                />
                {error ? (
                  <p className="px-1 text-sm leading-6 font-medium text-[#bf5636]">{error.message}</p>
                ) : (
                  <p className="px-1 text-sm leading-6 font-medium text-[#7d7167]">
                    We sent a 6-digit code to{" "}
                    <span className="font-mono text-[#171310]">{email}</span>.
                  </p>
                )}
                <button
                  className={cn(
                    "px-1 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-[#171310]/20 focus-visible:outline-none",
                    cooldown > 0
                      ? "cursor-not-allowed text-[#a89d92]"
                      : "text-[#bf5636] hover:text-[#ad492d]"
                  )}
                  disabled={cooldown > 0 || submitting}
                  onClick={resendCode}
                  type="button"
                >
                  {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
                </button>
              </form>
            ) : null}

            {step === "capture" ? (
              <div className="space-y-5">
                <button
                  className="flex h-[78px] w-full items-center justify-between rounded-[25px] border border-[#e6dacd] bg-[#fffaf3]/82 px-7 text-left font-mono text-[17px] font-medium text-[#171310] shadow-[inset_0_1px_0_rgb(255_255_255/0.68)] transition-colors hover:bg-[#fffaf3] focus-visible:ring-2 focus-visible:ring-[#171310]/18 focus-visible:outline-none"
                  onClick={copyAddress}
                  type="button"
                >
                  <span>{CAPTURE_ADDRESS}</span>
                  <span className="flex items-center gap-2 font-sans text-sm text-[#8e8378]">
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                    {copied ? "Copied" : "Copy"}
                  </span>
                </button>
                <p className="px-1 text-sm leading-6 font-medium text-[#7d7167]">
                  BCC, forward, or email Keeps directly. Keeps stays invisible to everyone else.
                </p>
              </div>
            ) : null}

            {step === "style" ? <WorkingStylePicker styles={workingStyles} /> : null}

            {step === "done" ? (
              <div className="rounded-[25px] border border-[#e6dacd] bg-[#fffaf3]/82 px-7 py-6 shadow-[inset_0_1px_0_rgb(255_255_255/0.68)]">
                <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-[#bf5636] text-white">
                  <Check className="size-5" strokeWidth={2.6} />
                </div>
                <p className="text-[17px] leading-7 font-medium text-[#171310]">
                  Send work to <span className="font-mono">{CAPTURE_ADDRESS}</span>. Keeps will
                  remember it privately.
                </p>
              </div>
            ) : null}
          </div>

          <div className="mt-5 space-y-4">
            {step === "email" ? (
              <p className="max-w-[510px] text-[15px] leading-6 font-medium text-[#8e8378]">
                External actions always require approval.
              </p>
            ) : null}

            <div className="flex items-center gap-3">
              {step !== "email" && step !== "done" ? (
                <button
                  className="h-16 rounded-[22px] px-5 text-sm font-semibold text-[#7d7167] transition-colors hover:text-[#171310] focus-visible:ring-2 focus-visible:ring-[#171310]/20 focus-visible:outline-none"
                  onClick={goBack}
                  type="button"
                >
                  Back
                </button>
              ) : null}

              {step === "email" ? (
                <button
                  className={cn(primaryButtonClass, "w-full")}
                  disabled={!isLoaded || submitting}
                  form="keeps-email-form"
                  type="submit"
                >
                  {submitting ? "Sending code…" : "Continue"}
                </button>
              ) : null}

              {step === "code" ? (
                <button
                  className={cn(primaryButtonClass, "flex flex-1 items-center justify-center gap-2")}
                  disabled={!isLoaded || submitting || code.length !== 6}
                  form="keeps-code-form"
                  type="submit"
                >
                  {submitting ? "Verifying…" : "Verify"}
                  {!submitting ? <ArrowRight className="size-4" strokeWidth={2.6} /> : null}
                </button>
              ) : null}

              {step === "capture" ? (
                <button
                  className={cn(primaryButtonClass, "flex flex-1 items-center justify-center gap-2")}
                  onClick={() => setStep("style")}
                  type="button"
                >
                  Continue
                  <ArrowRight className="size-4" strokeWidth={2.6} />
                </button>
              ) : null}

              {step === "style" ? (
                <button
                  className={cn(primaryButtonClass, "flex flex-1 items-center justify-center gap-2")}
                  onClick={() => setStep("done")}
                  type="button"
                >
                  Finish
                  <ArrowRight className="size-4" strokeWidth={2.6} />
                </button>
              ) : null}

              {step === "done" ? (
                <button
                  className={cn(primaryButtonClass, "w-full")}
                  onClick={() => setStep(sessionEmail || email ? "capture" : "email")}
                  type="button"
                >
                  Review setup
                </button>
              ) : null}
            </div>
          </div>

          <div
            className="mt-7 flex gap-1.5"
            aria-label={`Step ${Math.min(stepIndex + 1, steps.length)} of ${steps.length}`}
          >
            {steps.map((item, index) => (
              <span
                className={cn(
                  "h-1.5 flex-1 rounded-full bg-[#ebe1d6] transition-colors",
                  index <= Math.min(stepIndex, steps.length - 1) && "bg-[#171310]"
                )}
                key={item}
              />
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
