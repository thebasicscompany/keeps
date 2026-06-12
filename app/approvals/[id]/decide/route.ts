/**
 * app/approvals/[id]/decide/route.ts
 *
 * POST handler for the approval decision form.
 *
 * Implements PRG (Post/Redirect/Get) — on success, redirects back to the
 * page with ?state=<outcome> so refreshes don't re-submit.
 *
 * Security:
 *   - Token and action come from FormData only — never from path or query params.
 *   - Token is re-verified by decideFromWeb before any state transition.
 *   - already_decided is handled idempotently; double-submits get a clean
 *     confirmation page, never an error.
 *   - `now` is minted once per request here.
 */

import { NextResponse } from "next/server";
import { decideFromWeb } from "@/approvals/decide-web";
import { DrizzleApprovalRepository } from "@/approvals/repository";

type Params = { id: string };

export async function POST(
  request: Request,
  context: { params: Promise<Params> },
): Promise<Response> {
  const { id: approvalId } = await context.params;
  const now = new Date();

  // Parse form data — the confirmation page posts as a plain HTML form.
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form_data" }, { status: 400 });
  }

  const token = formData.get("token");
  const action = formData.get("action");

  // Validate presence and type.
  if (typeof token !== "string" || !token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  if (action !== "approve" && action !== "cancel") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const repository = new DrizzleApprovalRepository();

  const result = await decideFromWeb({
    approvalId,
    token,
    action,
    now,
    repository,
  });

  const pageBase = `/approvals/${approvalId}`;

  switch (result.outcome) {
    case "decided":
      // PRG: redirect to the page with ?state=<decision> so refresh is safe.
      return NextResponse.redirect(
        new URL(
          `${pageBase}?state=${result.decision === "approved" ? "approved" : "cancelled"}`,
          request.url,
        ),
        { status: 303 },
      );

    case "already_decided":
      // Idempotent — redirect to the page; the page will show the current state.
      // We don't pass the token back in the redirect URL.
      return NextResponse.redirect(new URL(`${pageBase}?state=already_decided`, request.url), {
        status: 303,
      });

    case "expired":
      return NextResponse.redirect(
        new URL(`${pageBase}?state=expired`, request.url),
        { status: 303 },
      );

    case "invalid_token":
      return NextResponse.redirect(
        new URL(`${pageBase}?state=invalid`, request.url),
        { status: 303 },
      );

    case "not_found":
      return NextResponse.redirect(
        new URL(`${pageBase}?state=not_found`, request.url),
        { status: 303 },
      );

    default: {
      // Exhaustive check — TypeScript should ensure this is unreachable.
      const _exhaustive: never = result;
      return NextResponse.json({ error: "unexpected" }, { status: 500 });
    }
  }
}
