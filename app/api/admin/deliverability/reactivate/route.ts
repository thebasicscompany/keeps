/**
 * app/api/admin/deliverability/reactivate/route.ts
 *
 * POST — reactivate a single suppressed/bounced/complained user.
 * Admin-gated via requireAdmin().
 *
 * Body: { userId: string }
 *
 * Resets users.outboundEmailState to 'active' and writes an audit_log row
 * with action 'email.outbound.reactivated', actorType 'admin', metadata
 * containing { priorState, adminUserId }.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdmin } from "@/admin/require-admin";
import { reactivateUser } from "@/admin/deliverability-admin";

export async function POST(request: NextRequest): Promise<Response> {
  const gate = await requireAdmin();
  if ("forbidden" in gate) {
    return NextResponse.json({ error: "Admins only." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const userId =
    body && typeof body === "object" && "userId" in body
      ? (body as { userId?: unknown }).userId
      : undefined;

  if (typeof userId !== "string" || userId.trim().length === 0) {
    return NextResponse.json({ error: "userId is required." }, { status: 400 });
  }

  const result = await reactivateUser({ userId, adminUserId: gate.userId });

  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({ ok: true, priorState: result.priorState });
}
