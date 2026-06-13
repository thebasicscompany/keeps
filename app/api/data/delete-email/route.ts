/**
 * app/api/data/delete-email/route.ts
 *
 * POST { inboundEmailId: string }
 *
 * Auth: Clerk JWT → users.id via user_identities.
 * Returns:
 *   200 { ok: true, deletedLoops, deletedSourceEvidence, deletedNudges }
 *   404 { error: "not_found" }   — email missing or belongs to another user
 *   400 { error: "bad_request" } — missing / invalid body
 *   401 { error: "unauthorized" }
 */

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userIdentities } from "@/db/schema";
import { deleteEmailForUser } from "@/data/delete-email";

export const runtime = "nodejs";

export async function POST(req: Request) {
  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // -------------------------------------------------------------------------
  // Parse body
  // -------------------------------------------------------------------------
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).inboundEmailId !== "string" ||
    !(body as Record<string, unknown>).inboundEmailId
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { inboundEmailId } = body as { inboundEmailId: string };

  // -------------------------------------------------------------------------
  // Resolve Clerk user → users.id
  // -------------------------------------------------------------------------
  const db = getDb();

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
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------
  const result = await deleteEmailForUser(
    { userId: identity.userId, inboundEmailId },
    db,
  );

  if (!result.found) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    deletedLoops: result.deletedLoops,
    deletedSourceEvidence: result.deletedSourceEvidence,
    deletedNudges: result.deletedNudges,
  });
}
