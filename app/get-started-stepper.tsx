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

const primaryButtonClass = "keeps-button keeps-button-primary keeps-onboarding-primary";

const inputClass = "keeps-onboarding-input";

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

  // Synchronous in-flight guard prevents parallel Clerk calls when the
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
  // field this flow never collects); advancing would fake success with no
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
    // Part 1: synchronous in-flight guard blocks a second parallel call that
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
      // "verification_already_verified". Treat that, or a signUp already
      // showing complete, as success rather than an error.
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
    // Part 3: only auto-submit if this is a new 6-digit value; prevents a
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
    <main className="keeps-auth-main">
      <section className="keeps-onboarding-shell">
        <div className="keeps-card keeps-onboarding-card">
          <div className="keeps-onboarding-head">
            <div className="keeps-onboarding-title-block">
              <div
                className="keeps-onboarding-icon"
                aria-hidden="true"
              >
                {step === "email" ? (
                  <Archive className="keeps-onboarding-icon-svg" strokeWidth={2.6} />
                ) : step === "code" ? (
                  <ShieldCheck className="keeps-onboarding-icon-svg" strokeWidth={2.4} />
                ) : (
                  <Mail className="keeps-onboarding-icon-svg" strokeWidth={2.4} />
                )}
              </div>
              <p className="keeps-eyebrow">Get started</p>
              <h1>Welcome to Keeps</h1>
              <p className="keeps-onboarding-subtitle">
                {step === "email" && "What's your work email?"}
                {step === "code" && "Enter your code."}
                {step === "capture" && "Save your capture address."}
                {step === "style" && "How should Keeps write?"}
                {step === "done" && "You're ready."}
              </p>
            </div>

            {step !== "done" ? (
              <button
                className="keeps-onboarding-ghost"
                onClick={() => setStep("done")}
                type="button"
              >
                Set up later
              </button>
            ) : null}
          </div>

          <div className="keeps-onboarding-stage">
            {step === "email" ? (
              <form className="keeps-onboarding-form" id="keeps-email-form" onSubmit={startSignUp}>
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
                  <p className="keeps-onboarding-message is-error">
                    {error.message}
                    {error.existing ? (
                      <>
                        {" "}
                        <Link
                          className="keeps-document-link"
                          href={"/sign-in" as Route}
                        >
                          Sign in instead
                        </Link>
                        .
                      </>
                    ) : null}
                  </p>
                ) : (
                  <p className="keeps-onboarding-message">
                    Keeps only accepts messages from an address you verify.
                  </p>
                )}
              </form>
            ) : null}

            {step === "code" ? (
              <form className="keeps-onboarding-form" id="keeps-code-form" onSubmit={onCodeFormSubmit}>
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
                  className={cn(inputClass, "keeps-onboarding-code-input")}
                  value={code}
                  onChange={onCodeChange}
                />
                {error ? (
                  <p className="keeps-onboarding-message is-error">{error.message}</p>
                ) : (
                  <p className="keeps-onboarding-message">
                    We sent a 6-digit code to{" "}
                    <span>{email}</span>.
                  </p>
                )}
                <button
                  className={cn(
                    "keeps-onboarding-text-button",
                    cooldown > 0 && "is-disabled"
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
              <div className="keeps-onboarding-form">
                <button
                  className="keeps-capture-address-card"
                  onClick={copyAddress}
                  type="button"
                >
                  <span>{CAPTURE_ADDRESS}</span>
                  <span
                    className={cn(
                      "keeps-capture-address-action",
                      copied && "is-copied"
                    )}
                  >
                    {copied ? (
                      <Check className="keeps-capture-icon" />
                    ) : (
                      <Copy className="keeps-capture-icon" />
                    )}
                    {copied ? "Copied" : "Copy"}
                  </span>
                </button>
                <p className="keeps-onboarding-message">
                  BCC, forward, or email Keeps directly. Keeps stays invisible to everyone else.
                </p>
              </div>
            ) : null}

            {step === "style" ? <WorkingStylePicker styles={workingStyles} /> : null}

            {step === "done" ? (
              <div className="keeps-onboarding-done-card">
                <div className="keeps-onboarding-done-icon">
                  <Check className="keeps-onboarding-done-svg" strokeWidth={2.6} />
                </div>
                <p>
                  Send work to <span>{CAPTURE_ADDRESS}</span>. Keeps will
                  remember it privately.
                </p>
                <p className="keeps-onboarding-message">
                  Ready to invite your team?{" "}
                  <Link className="keeps-document-link" href={"/settings/billing" as Route}>
                    Choose a plan
                  </Link>
                  .
                </p>
              </div>
            ) : null}
          </div>

          <div className="keeps-onboarding-footer-controls">
            {step === "email" ? (
              <p className="keeps-onboarding-note">
                External actions always require approval.
              </p>
            ) : null}

            <div className="keeps-onboarding-actions">
              {step !== "email" && step !== "done" ? (
                <button
                  className="keeps-onboarding-back"
                  onClick={goBack}
                  type="button"
                >
                  Back
                </button>
              ) : null}

              {step === "email" ? (
                <button
                  className={primaryButtonClass}
                  disabled={!isLoaded || submitting}
                  form="keeps-email-form"
                  type="submit"
                >
                  {submitting ? "Sending code…" : "Continue"}
                </button>
              ) : null}

              {step === "code" ? (
                <button
                  className={cn(primaryButtonClass, "keeps-onboarding-primary-with-icon")}
                  disabled={!isLoaded || submitting || code.length !== 6}
                  form="keeps-code-form"
                  type="submit"
                >
                  {submitting ? "Verifying…" : "Verify"}
                  {!submitting ? <ArrowRight className="keeps-onboarding-arrow" strokeWidth={2.6} /> : null}
                </button>
              ) : null}

              {step === "capture" ? (
                <button
                  className={cn(primaryButtonClass, "keeps-onboarding-primary-with-icon")}
                  onClick={() => setStep("style")}
                  type="button"
                >
                  Continue
                  <ArrowRight className="keeps-onboarding-arrow" strokeWidth={2.6} />
                </button>
              ) : null}

              {step === "style" ? (
                <button
                  className={cn(primaryButtonClass, "keeps-onboarding-primary-with-icon")}
                  onClick={() => setStep("done")}
                  type="button"
                >
                  Finish
                  <ArrowRight className="keeps-onboarding-arrow" strokeWidth={2.6} />
                </button>
              ) : null}

              {step === "done" ? (
                <>
                  <button
                    className="keeps-onboarding-back"
                    onClick={() => setStep(sessionEmail || email ? "capture" : "email")}
                    type="button"
                  >
                    Review setup
                  </button>
                  <Link
                    className={cn(primaryButtonClass, "keeps-onboarding-primary-with-icon")}
                    href={"/settings/graph" as Route}
                  >
                    Go to Keeps
                    <ArrowRight className="keeps-onboarding-arrow" strokeWidth={2.6} />
                  </Link>
                </>
              ) : null}
            </div>
          </div>

          <div
            className="keeps-onboarding-progress"
            aria-label={`Step ${Math.min(stepIndex + 1, steps.length)} of ${steps.length}`}
          >
            {steps.map((item, index) => (
              <span
                className={cn(
                  index <= Math.min(stepIndex, steps.length - 1) && "is-active"
                )}
                key={item}
              />
            ))}
          </div>

          {/* Privacy promise: visible on all steps */}
          <p className="keeps-onboarding-privacy">
            Raw email bodies are deleted after 30 days by default. Your extracted
            loops stay until you remove them. You can view, export, or delete all
            your data, including your full account, any time from Settings.{" "}
            <Link
              href={"/privacy" as Route}
              className="keeps-document-link"
            >
              Privacy policy
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}
