/**
 * app/api/data/delete/route.ts
 *
 * POST — request account-wide, irreversible deletion of the authenticated
 * user's account and all associated data.
 *
 * Body: { typedEmail: string }
 *
 * Flow:
 *   1. Clerk auth() → clerk user id. 401 if unauthenticated.
 *   2. Resolve users.id + users.email via user_identities(provider='clerk').
 *   3. Require typedEmail === the user's verified email (case-insensitive,
 *      trimmed). 400 otherwise — this is the confirmation gate so a misclick
 *      can never delete an account.
 *   4. Insert a data_deletion_requests row (status 'pending', userId, email).
 *   5. Write a data.delete_requested audit row + emit the data.delete_requested
 *      Inngest event { dataDeletionRequestId, userId, email }.
 *   6. Return { status: 'pending', dataDeletionRequestId }.
 *
 * The heavy lifting (Clerk delete + DB cascade) happens asynchronously in the
 * `process-data-deletion` Inngest function. This route only records intent.
 */

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users, userIdentities, auditLog, dataDeletionRequests } from "@/db/schema";
import { sendEvent } from "@/workflows/events";

export async function POST(request: NextRequest): Promise<Response> {
  // --- 1. Auth ---------------------------------------------------------------
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  // --- Parse body ------------------------------------------------------------
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const typedEmail =
    body && typeof body === "object" && "typedEmail" in body
      ? (body as { typedEmail?: unknown }).typedEmail
      : undefined;

  if (typeof typedEmail !== "string" || typedEmail.trim().length === 0) {
    return NextResponse.json(
      { error: "typedEmail is required." },
      { status: 400 },
    );
  }

  const db = getDb();

  // --- 2. Resolve users.id + users.email -------------------------------------
  const [row] = await db
    .select({ userId: users.id, email: users.email })
    .from(users)
    .innerJoin(
      userIdentities,
      and(
        eq(userIdentities.userId, users.id),
        eq(userIdentities.provider, "clerk"),
        eq(userIdentities.providerAccountId, clerkUserId),
      ),
    )
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  // --- 3. Confirmation gate: typed email must match the verified email -------
  const normalizedTyped = typedEmail.trim().toLowerCase();
  const normalizedActual = row.email.trim().toLowerCase();
  if (normalizedTyped !== normalizedActual) {
    return NextResponse.json(
      { error: "The email you typed does not match your account email." },
      { status: 400 },
    );
  }

  // --- 4. Insert the deletion request row ------------------------------------
  const [deletionRequest] = await db
    .insert(dataDeletionRequests)
    .values({
      userId: row.userId,
      email: row.email,
      status: "pending",
    })
    .returning({ id: dataDeletionRequests.id });

  const dataDeletionRequestId = deletionRequest.id;

  // --- 5. Audit + emit -------------------------------------------------------
  await db.insert(auditLog).values({
    userId: row.userId,
    action: "data.delete_requested",
    actorType: "user",
    metadata: { dataDeletionRequestId },
  });

  await sendEvent("data.delete_requested", {
    dataDeletionRequestId,
    userId: row.userId,
    email: row.email,
  });

  // --- 6. Respond ------------------------------------------------------------
  return NextResponse.json({ status: "pending", dataDeletionRequestId });
}
