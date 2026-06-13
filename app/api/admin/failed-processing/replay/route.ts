/**
 * app/api/admin/failed-processing/replay/route.ts
 *
 * POST — replay or resolve a single dead-letter (failed_processing) row.
 * Admin-gated via requireAdmin().
 *
 * Body: { id: string, action: 'replay' | 'resolve', notes?: string }
 *
 *  - replay:  re-emit the stored event (eventName + eventPayload) through Inngest.
 *             process-email's idempotency key (event.data.inboundEmailId) dedupes a
 *             replay whose inbound email was already processed, so no double-create.
 *             Stamps replayedAt = now and writes a `failed_processing.replayed` audit
 *             row attributed to the admin.
 *  - resolve: stamps resolvedAt = now (+ optional notes). Emits nothing.
 *
 * The actual mutation lives in src/workflows/replay-failed-processing.ts so the
 * headless CLI (scripts/replay-failed-processing.ts) shares identical behavior.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdmin } from "@/admin/require-admin";
import { replayFailedProcessing, type ReplayAction } from "@/workflows/replay-failed-processing";

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

  const id =
    body && typeof body === "object" && "id" in body ? (body as { id?: unknown }).id : undefined;
  const action =
    body && typeof body === "object" && "action" in body
      ? (body as { action?: unknown }).action
      : undefined;
  const notes =
    body && typeof body === "object" && "notes" in body
      ? (body as { notes?: unknown }).notes
      : undefined;

  if (typeof id !== "string" || id.trim().length === 0) {
    return NextResponse.json({ error: "id is required." }, { status: 400 });
  }
  if (action !== "replay" && action !== "resolve") {
    return NextResponse.json(
      { error: "action must be 'replay' or 'resolve'." },
      { status: 400 },
    );
  }

  const result = await replayFailedProcessing({
    id,
    action: action as ReplayAction,
    actorUserId: gate.userId,
    notes: typeof notes === "string" ? notes : null,
  });

  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json(result);
}
