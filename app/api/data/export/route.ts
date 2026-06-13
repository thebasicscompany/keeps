/**
 * app/api/data/export/route.ts
 *
 * POST — authenticated endpoint that enqueues a data export for the calling user.
 *
 * Auth pattern: auth() from @clerk/nextjs/server yields the Clerk user ID;
 * we join against user_identities to resolve the internal users.id UUID.
 *
 * Flow:
 *   1. Resolve Clerk session → internal userId.
 *   2. Emit `data.export_requested` { userId, requestedAt }.
 *   3. Write audit row (data.export_requested).
 *   4. Return { status: 'requested' }.
 *
 * The actual export assembly runs async in the generate-data-export Inngest function.
 * The caller (B1's /settings/data page) polls or awaits the export email.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userIdentities, auditLog } from "@/db/schema";
import { inngest } from "@/workflows/client";

export async function POST(_request: NextRequest): Promise<Response> {
  try {
    // 1. Resolve auth
    const { userId: clerkUserId } = await auth();

    if (!clerkUserId) {
      return NextResponse.json({ error: "Unauthenticated." }, { status: 401 });
    }

    // 2. Resolve internal user ID
    let db: ReturnType<typeof getDb>;
    try {
      db = getDb();
    } catch {
      return NextResponse.json({ error: "Service unavailable." }, { status: 503 });
    }

    const [identity] = await db
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.provider, "clerk"),
          eq(userIdentities.providerAccountId, clerkUserId),
        ),
      )
      .limit(1);

    if (!identity) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    const userId = identity.userId;
    const requestedAt = new Date().toISOString();

    // 3. Emit workflow event (triggers generate-data-export)
    await inngest.send({
      name: "data.export_requested",
      data: { userId, requestedAt },
    });

    // 4. Write audit row
    await db.insert(auditLog).values({
      userId,
      action: "data.export_requested",
      actorType: "user",
      metadata: { requestedAt },
    });

    return NextResponse.json({ status: "requested" }, { status: 202 });
  } catch (err) {
    console.error("[data/export] POST error:", err instanceof Error ? err.message : "unknown");
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
