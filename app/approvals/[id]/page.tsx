/**
 * app/approvals/[id]/page.tsx
 *
 * Server component — renders the approval confirmation screen.
 *
 * URL contract (matches the email link builder in the parallel agent):
 *   GET /approvals/<approvalId>?token=<plaintext>&action=approve|cancel
 *
 * Security:
 *   - Token is never echoed back into HTML (not in error messages, not in
 *     hidden fields in the initial GET — the POST form only passes it
 *     forward to /decide, which re-verifies it).
 *   - requiresLogin=true on the draft → Clerk session required; unauthenticated
 *     visitors are redirected to /sign-in with a ?redirect_url= param so they
 *     land back here after authentication.
 *   - `now` is minted once per request at the top of the component.
 */

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { loadApprovalForWeb } from "@/approvals/decide-web";
import { DrizzleApprovalRepository } from "@/approvals/repository";

// ---------------------------------------------------------------------------
// Design tokens — match get-started-stepper.tsx exactly
// ---------------------------------------------------------------------------

const creamBg = "bg-[#FAFAF8]";
const cardBg = "bg-white border border-[#E2E2DD] shadow-[0_24px_70px_rgba(20,20,15,0.07)]";
const labelMuted = "text-[#6F6F66]";
// Bezeled square seafoam primary — mirrors primaryButtonClass in app/get-started-stepper.tsx.
const primaryBtn =
  "h-14 rounded-none border border-[rgba(30,107,79,0.32)] bg-[#C1F5DF] px-6 text-base font-semibold text-[#14140F] shadow-[inset_0_1px_0_rgba(255,255,255,0.75),inset_0_-2px_0_rgba(30,107,79,0.28),0_12px_24px_rgba(30,107,79,0.16)] transition-colors hover:bg-[#AFF0D3] focus-visible:ring-2 focus-visible:ring-[rgba(30,107,79,0.32)] focus-visible:outline-none";
const secondaryBtn =
  "h-14 rounded-none px-6 text-base font-semibold text-[#6F6F66] transition-colors hover:text-[#14140F] focus-visible:ring-2 focus-visible:ring-[#14140F]/20 focus-visible:outline-none";

// ---------------------------------------------------------------------------
// Payload summary — renders the draft payload in a human-readable way.
// Never renders raw token or internal IDs.
// ---------------------------------------------------------------------------

function PayloadSummary({ actionKind, payload }: { actionKind: string; payload: Record<string, unknown> }) {
  const entries = Object.entries(payload).filter(([key]) =>
    // Strip internal / sensitive keys.
    !["token", "tokenHash", "id", "userId", "draftId"].includes(key),
  );

  return (
    <div className={`rounded-none border border-[#E2E2DD] ${creamBg} px-5 py-4`}>
      <p className="mb-3 text-sm font-semibold text-[#14140F]">
        Action: <span className="font-mono text-[#1E6B4F]">{actionKind}</span>
      </p>
      {entries.length > 0 ? (
        <dl className="space-y-1">
          {entries.map(([key, value]) => (
            <div key={key} className="flex gap-2 text-sm">
              <dt className={`min-w-[100px] font-medium ${labelMuted}`}>{key}</dt>
              <dd className="font-medium text-[#14140F] break-all">
                {typeof value === "object" ? JSON.stringify(value) : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className={`text-sm ${labelMuted}`}>No additional details.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error / terminal state screens
// ---------------------------------------------------------------------------

function ErrorScreen({ title, message }: { title: string; message: string }) {
  return (
    <main className={`relative z-10 min-h-svh ${creamBg} text-[#14140F]`}>
      <section className="mx-auto flex min-h-svh w-full max-w-[546px] flex-col justify-center px-5 py-9 sm:px-0">
        <div className={`rounded-none ${cardBg} p-5 sm:p-6`}>
          <div className="mb-6">
            <div className="mb-5 flex size-14 items-center justify-center rounded-none bg-[#14140F] text-[#C1F5DF]">
              <svg
                aria-hidden="true"
                className="size-7"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.4}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
                />
              </svg>
            </div>
            <h1 className="text-[22px] leading-tight font-bold text-[#14140F]">{title}</h1>
            <p className={`mt-2 text-base leading-relaxed ${labelMuted}`}>{message}</p>
          </div>
        </div>
      </section>
    </main>
  );
}

function AlreadyDecidedScreen({ status }: { status: string }) {
  const label =
    status === "approved"
      ? "This action was approved."
      : status === "cancelled"
        ? "This request was cancelled."
        : status === "rejected"
          ? "This request was rejected."
          : status === "expired"
            ? "This approval link has expired."
            : "This request has already been decided.";

  return (
    <main className={`relative z-10 min-h-svh ${creamBg} text-[#14140F]`}>
      <section className="mx-auto flex min-h-svh w-full max-w-[546px] flex-col justify-center px-5 py-9 sm:px-0">
        <div className={`rounded-none ${cardBg} p-5 sm:p-6`}>
          <div className="mb-6">
            <div className="mb-5 flex size-14 items-center justify-center rounded-none bg-[#14140F] text-[#C1F5DF]">
              <svg
                aria-hidden="true"
                className="size-7"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.4}
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <h1 className="text-[22px] leading-tight font-bold text-[#14140F]">Already decided</h1>
            <p className={`mt-2 text-base leading-relaxed ${labelMuted}`}>{label}</p>
          </div>
        </div>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Confirmation screens
// ---------------------------------------------------------------------------

function ConfirmScreen({
  approvalId,
  token,
  actionKind,
  payload,
  mode,
}: {
  approvalId: string;
  token: string;
  actionKind: string;
  payload: Record<string, unknown>;
  mode: "approve" | "cancel";
}) {
  const isApprove = mode === "approve";

  return (
    <main className={`relative z-10 min-h-svh ${creamBg} text-[#14140F]`}>
      <section className="mx-auto flex min-h-svh w-full max-w-[546px] flex-col justify-center px-5 py-9 sm:px-0">
        <div className={`rounded-none ${cardBg} p-5 sm:p-6`}>
          {/* Header */}
          <div className="mb-7">
            <div className="mb-5 flex size-14 items-center justify-center rounded-none bg-[#14140F] text-[#C1F5DF]">
              {isApprove ? (
                <svg
                  aria-hidden="true"
                  className="size-7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.4}
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              ) : (
                <svg
                  aria-hidden="true"
                  className="size-7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.4}
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 18 18 6M6 6l12 12"
                  />
                </svg>
              )}
            </div>
            <h1 className="text-[28px] leading-tight font-bold tracking-normal text-[#14140F]">
              {isApprove ? "Approve this action?" : "Cancel this action?"}
            </h1>
            <p className={`mt-1 text-base leading-relaxed font-medium ${labelMuted}`}>
              {isApprove
                ? "Keeps will execute the following action on your behalf."
                : "This action will be cancelled and no changes will be made."}
            </p>
          </div>

          {/* Payload summary */}
          <div className="mb-7">
            <PayloadSummary actionKind={actionKind} payload={payload} />
          </div>

          {/* Action buttons — form POST for PRG pattern */}
          <div className="space-y-3">
            <form action={`/approvals/${approvalId}/decide`} method="POST">
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="action" value={mode === "approve" ? "approve" : "cancel"} />
              <button className={`${primaryBtn} w-full`} type="submit">
                {isApprove ? "Approve" : "Cancel this action"}
              </button>
            </form>

            {/* Secondary: the opposite action */}
            <form action={`/approvals/${approvalId}/decide`} method="POST">
              <input type="hidden" name="token" value={token} />
              <input
                type="hidden"
                name="action"
                value={mode === "approve" ? "cancel" : "approve"}
              />
              <button className={`${secondaryBtn} w-full text-center`} type="submit">
                {isApprove ? "Cancel instead" : "Approve instead"}
              </button>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Decided confirmation (shown after PRG redirect with ?state=approved|cancelled)
// ---------------------------------------------------------------------------

function DecidedConfirmationScreen({ state }: { state: string }) {
  const isApproved = state === "approved";

  return (
    <main className={`relative z-10 min-h-svh ${creamBg} text-[#14140F]`}>
      <section className="mx-auto flex min-h-svh w-full max-w-[546px] flex-col justify-center px-5 py-9 sm:px-0">
        <div className={`rounded-none ${cardBg} p-5 sm:p-6`}>
          <div className="mb-6">
            <div className="mb-5 flex size-14 items-center justify-center rounded-none bg-[#14140F] text-[#C1F5DF]">
              <svg
                aria-hidden="true"
                className="size-7"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.4}
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <h1 className="text-[22px] leading-tight font-bold text-[#14140F]">
              {isApproved ? "Action approved." : "Request cancelled."}
            </h1>
            <p className={`mt-2 text-base leading-relaxed ${labelMuted}`}>
              {isApproved
                ? "Keeps is executing this action. You'll receive a confirmation shortly."
                : "This action was cancelled. No changes were made."}
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string; action?: string; state?: string }>;
};

export default async function ApprovalPage({ params, searchParams }: Props) {
  const { id: approvalId } = await params;
  const { token, action, state } = await searchParams;

  // If this is a post-decision redirect (PRG), render the confirmation screen.
  if (state === "approved" || state === "cancelled") {
    return <DecidedConfirmationScreen state={state} />;
  }

  // If this is a post-decision redirect for already_decided, show gracefully.
  if (state === "already_decided") {
    return <AlreadyDecidedScreen status="approved" />;
  }

  const now = new Date();

  // Missing token → show a generic invalid screen (never echo it back).
  if (!token) {
    return (
      <ErrorScreen
        title="Invalid approval link"
        message="This approval link is missing required information. Check that you used the full link from the email."
      />
    );
  }

  // Determine the action mode.
  const actionMode: "approve" | "cancel" | null =
    action === "approve" ? "approve" : action === "cancel" ? "cancel" : null;

  if (actionMode === null) {
    return (
      <ErrorScreen
        title="Invalid approval link"
        message="This link doesn't specify a valid action. Use the approve or cancel link from the email."
      />
    );
  }

  // Load and verify the approval request.
  const repository = new DrizzleApprovalRepository();
  const loaded = await loadApprovalForWeb({ approvalId, token, now, repository });

  if (loaded.state === "not_found") {
    return (
      <ErrorScreen
        title="Approval not found"
        message="This approval request doesn't exist or may have been deleted."
      />
    );
  }

  if (loaded.state === "invalid_token") {
    return (
      <ErrorScreen
        title="Invalid approval link"
        message="This approval link is not valid. Use the original link from the email."
      />
    );
  }

  if (loaded.state === "expired") {
    return (
      <ErrorScreen
        title="Approval link expired"
        message="This approval link has expired. Approval links are valid for 7 days."
      />
    );
  }

  if (loaded.state === "already_decided") {
    return <AlreadyDecidedScreen status={loaded.status} />;
  }

  // At this point state === "valid". Check requiresLogin.
  const { draft } = loaded;

  if (draft.requiresLogin) {
    const { userId } = await auth();
    if (!userId) {
      // Build the full return URL preserving token + action.
      const returnUrl = `/approvals/${approvalId}?token=${encodeURIComponent(token)}&action=${action}`;
      redirect(`/sign-in?redirect_url=${encodeURIComponent(returnUrl)}` as Route);
    }
  }

  return (
    <ConfirmScreen
      approvalId={approvalId}
      token={token}
      actionKind={draft.actionKind}
      payload={draft.payload as Record<string, unknown>}
      mode={actionMode}
    />
  );
}
