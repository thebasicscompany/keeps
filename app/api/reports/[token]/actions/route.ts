/**
 * app/api/reports/[token]/actions/route.ts
 *
 * POST handler for report row-actions: done, dismiss, snooze, draft_nudge.
 *
 * Token is the report view token from the URL path — verified server-side by
 * applyReportRowAction; never echoed back in error responses.
 *
 * Returns:
 *   200 { status: "applied"|"drafted", sections }   — success; sections for client re-render
 *   200 { error: "This view is no longer available." } — not_found / expired (no leak)
 *   400 { error }   — validation or invalid action result
 *   500 { error }   — unexpected server error
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { applyReportRowAction } from "@/reports/service";
import type { ReportRowAction } from "@/reports/service";
import { DrizzleReportsRepository } from "@/reports/repository";
import { DrizzleLoopProcessingRepository } from "@/loops/repository";
import { DrizzleNudgeRepository } from "@/nudges/repository";

const VALID_ACTIONS: ReportRowAction[] = ["done", "dismiss", "snooze", "draft_nudge"];

type Params = { token: string };

export async function POST(
  request: NextRequest,
  context: { params: Promise<Params> },
): Promise<Response> {
  try {
    const { token } = await context.params;

    // Parse JSON body.
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
    }

    const body = rawBody as Record<string, unknown>;
    const { loopId, action, snoozeUntil } = body;

    // Validate required fields.
    if (typeof loopId !== "string" || !loopId) {
      return NextResponse.json({ error: "loopId is required." }, { status: 400 });
    }

    if (typeof action !== "string" || !VALID_ACTIONS.includes(action as ReportRowAction)) {
      return NextResponse.json(
        { error: `action must be one of: ${VALID_ACTIONS.join(", ")}.` },
        { status: 400 },
      );
    }

    const validatedAction = action as ReportRowAction;
    const validatedSnoozeUntil =
      typeof snoozeUntil === "string" ? snoozeUntil : undefined;

    // Build repositories.
    const reportsRepository = new DrizzleReportsRepository();
    const loopRepository = new DrizzleLoopProcessingRepository();

    // enqueueDraftNudge: create a PENDING nudge row for the loop (no outbound send).
    const enqueueDraftNudge = async ({
      userId,
      loopId: draftLoopId,
    }: {
      userId: string;
      loopId: string;
    }): Promise<void> => {
      const nudgeRepository = new DrizzleNudgeRepository();
      await nudgeRepository.createNudgeRow({
        userId,
        loopId: draftLoopId,
        inboundEmailId: null,
        subject: "Draft nudge",
        body: "",
        type: "nudge",
        metadata: { kind: "draft_nudge", loopId: draftLoopId },
      });
    };

    // Apply the action via the reports service.
    const result = await applyReportRowAction({
      token,
      now: new Date(),
      body: {
        loopId,
        action: validatedAction,
        snoozeUntil: validatedSnoozeUntil ?? null,
      },
      reportsRepository,
      loopRepository,
      enqueueDraftNudge,
    });

    // Map result to HTTP response.
    switch (result.status) {
      case "applied":
      case "drafted":
        return NextResponse.json({ status: result.status, sections: result.sections }, { status: 200 });

      case "not_found":
      case "expired":
        // Do NOT reveal which — return 200 to avoid leaking report existence.
        return NextResponse.json({ error: "This view is no longer available." }, { status: 200 });

      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });

      default: {
        // Exhaustive check — TypeScript should ensure this is unreachable.
        const _exhaustive: never = result;
        console.error("[reports/actions] Unexpected result status:", _exhaustive);
        return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
      }
    }
  } catch (err) {
    // Log without PII — no token, no user data.
    console.error("[reports/actions] Unexpected error in POST handler:", err instanceof Error ? err.message : "unknown");
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
