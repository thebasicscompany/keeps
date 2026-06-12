/**
 * TEMPORARY Phase 3 live-verification probe (Wave E3).
 *
 * Creates a `test_action` draft + approval request for a given user, which emits
 * `approval.requested` and kicks off the full handle-approval pipeline (approval
 * email with links, waitForEvent, execute funnel). Exists because Phase 3 ships no
 * production producer of approvals (connectors land in Phase 4) and Inngest events
 * cannot be emitted from outside the deployment (event key is env-only).
 *
 * Guarded by KEEPS_ADMIN_PROBE_SECRET (constant-time compare). Returns 404 when the
 * secret is unset so the route is inert unless explicitly armed.
 *
 * REMOVE (or keep consciously) after Phase 3 live verification — tracked in the
 * phase close-out.
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createApprovalRequest } from "@/approvals/service";
import { DrizzleApprovalRepository } from "@/approvals/repository";

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.KEEPS_ADMIN_PROBE_SECRET;

  if (!secret) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const provided = request.headers.get("x-keeps-admin-secret") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    userId?: string;
    ttlMs?: number;
    payload?: Record<string, unknown>;
  };

  if (!body.userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const { request: approval } = await createApprovalRequest({
    userId: body.userId,
    draft: {
      actionKind: "test_action",
      payload: body.payload ?? { note: "Phase 3 live verification" },
    },
    ...(body.ttlMs ? { ttlMs: body.ttlMs } : {}),
    now: new Date(),
    repository: new DrizzleApprovalRepository(),
  });

  // The plaintext token is intentionally NOT returned: handle-approval rotates it
  // and delivers the only usable link in the approval email.
  return NextResponse.json({
    ok: true,
    approvalId: approval.id,
    expiresAt: approval.expiresAt.toISOString(),
  });
}
