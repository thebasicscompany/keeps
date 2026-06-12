"use client";

import { Archive, ArrowRight, Check, Copy, Mail } from "lucide-react";
import { useMemo, useState } from "react";
import { workingStyles } from "@/product/working-styles";
import { cn } from "@/lib/utils";
import { WorkingStylePicker } from "./working-style-picker";

type StepId = "email" | "capture" | "style" | "done";

const steps: StepId[] = ["email", "capture", "style"];
const captureAddress = "agent@keeps.ai";
const primaryButtonClass =
  "h-16 rounded-[22px] border border-[#944023]/25 bg-[#bf5636] bg-linear-to-b from-white/18 to-black/8 px-6 text-base font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.28),inset_0_-1px_0_rgb(91_35_17/0.34),0_14px_28px_rgb(125_55_28/0.2)] transition-colors hover:bg-[#ad492d] focus-visible:ring-2 focus-visible:ring-[#bf5636]/32 focus-visible:outline-none";

export function GetStartedStepper({ sessionEmail }: { sessionEmail: string | null }) {
  const [step, setStep] = useState<StepId>(sessionEmail ? "capture" : "email");
  const [copied, setCopied] = useState(false);

  const stepIndex = useMemo(() => {
    if (step === "done") {
      return steps.length;
    }

    return Math.max(0, steps.indexOf(step));
  }, [step]);

  function copyAddress() {
    void navigator.clipboard?.writeText(captureAddress);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
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
                ) : (
                  <Mail className="size-7" strokeWidth={2.4} />
                )}
              </div>
              <h1 className="text-[28px] leading-tight font-medium tracking-normal text-[#171310]">
                Welcome to Keeps
              </h1>
              <p className="mt-1 text-[27px] leading-tight font-medium tracking-normal text-[#9a9086]">
                {step === "email" && "What's your work email?"}
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
              <form action="/api/auth/start" className="space-y-5" id="keeps-email-form" method="post">
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
                  className="h-[78px] w-full rounded-[25px] border border-[#e6dacd] bg-[#fffaf3]/82 px-7 text-[18px] font-medium text-[#171310] shadow-[inset_0_1px_0_rgb(255_255_255/0.68)] outline-none transition-colors placeholder:text-[#9d948b] focus:border-[#d4c1b1] focus:bg-[#fffaf3] focus:ring-0"
                  defaultValue={sessionEmail ?? ""}
                />
                <p className="px-1 text-sm leading-6 font-medium text-[#7d7167]">
                  Keeps only accepts messages from an address you verify.
                </p>
              </form>
            ) : null}

            {step === "capture" ? (
              <div className="space-y-5">
                <button
                  className="flex h-[78px] w-full items-center justify-between rounded-[25px] border border-[#e6dacd] bg-[#fffaf3]/82 px-7 text-left font-mono text-[17px] font-medium text-[#171310] shadow-[inset_0_1px_0_rgb(255_255_255/0.68)] transition-colors hover:bg-[#fffaf3] focus-visible:ring-2 focus-visible:ring-[#171310]/18 focus-visible:outline-none"
                  onClick={copyAddress}
                  type="button"
                >
                  <span>{captureAddress}</span>
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
                  Send work to <span className="font-mono">{captureAddress}</span>. Keeps will remember
                  it privately.
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
                  onClick={() => setStep(step === "style" ? "capture" : "email")}
                  type="button"
                >
                  Back
                </button>
              ) : null}

              {step === "email" ? (
                <button
                  className={cn(primaryButtonClass, "w-full")}
                  form="keeps-email-form"
                  type="submit"
                >
                  Continue
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
                  onClick={() => setStep(sessionEmail ? "capture" : "email")}
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
