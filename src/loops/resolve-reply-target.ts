import type { NormalizedEmail } from "@/email/normalize";
import type { PersistedLoop, PrivateReplyNudgeMetadata } from "@/loops/service";

/**
 * A nudge as needed to resolve a reply back to the loops it listed.
 * `metadata.ordinalMap` carries the 1-based ordinal → loop id mapping written at nudge creation.
 */
export type ResolvableNudge = {
  id: string;
  userId: string;
  metadata: PrivateReplyNudgeMetadata;
};

export type ResolvedReplyTarget = {
  nudgeId: string;
  loops: PersistedLoop[];
};

/**
 * Storage surface the resolver needs. The Drizzle implementation lives with the
 * repository/workflow wiring (Wave C); tests pass an in-memory fake.
 */
export type ReplyTargetStore = {
  /** Load a nudge by its id (the `n_<uuid>` mailbox-hash path). */
  findNudgeById(nudgeId: string): Promise<ResolvableNudge | null>;
  /**
   * Fallback: find the nudge whose outbound email carried this provider message id
   * in its `In-Reply-To` header. Resolves against `outbound_emails.in_reply_to`.
   *
   * TODO(phase-2.5-outbound): the Drizzle implementation of this method lives with
   * the `outbound_emails` work (src/email/outbound.ts + schema.ts), owned by a
   * parallel agent. The `outbound_emails` table is not in schema.ts yet, so no
   * Drizzle-backed ReplyTargetStore is wired here. The resolver's fallback logic
   * (header parsing + this call) is fully implemented and unit-tested against a
   * fake store; only the concrete persistence binding is deferred.
   */
  findNudgeByOutboundInReplyTo(inReplyTo: string): Promise<ResolvableNudge | null>;
  /** Load the loops referenced by id (used to hydrate the nudge's ordinalMap). */
  findLoopsByIds(loopIds: string[]): Promise<PersistedLoop[]>;
};

const MAILBOX_HASH_PATTERN = /^n_([0-9a-f-]+)$/i;

/**
 * Resolve an inbound reply back to the nudge it was sent in response to, plus the
 * loops that nudge listed (ordered by their 1-based ordinal).
 *
 * Resolution order:
 *   1. `mailboxHash` matches `^n_<uuid>$` → load the nudge by id.
 *   2. fallback: the `In-Reply-To` header matches an outbound message id recorded
 *      in `outbound_emails`.
 *   3. otherwise → null (the caller asks the user to reply directly to the nudge).
 */
export async function resolveReplyTarget(
  email: NormalizedEmail,
  deps: { store: ReplyTargetStore },
): Promise<ResolvedReplyTarget | null> {
  const nudge = (await resolveByMailboxHash(email, deps.store)) ?? (await resolveByInReplyTo(email, deps.store));

  if (!nudge) {
    return null;
  }

  return {
    nudgeId: nudge.id,
    loops: await loopsInOrdinalOrder(nudge.metadata.ordinalMap, deps.store),
  };
}

async function resolveByMailboxHash(email: NormalizedEmail, store: ReplyTargetStore): Promise<ResolvableNudge | null> {
  const match = email.mailboxHash ? MAILBOX_HASH_PATTERN.exec(email.mailboxHash) : null;

  if (!match) {
    return null;
  }

  const nudgeId = match[1];
  return store.findNudgeById(nudgeId);
}

async function resolveByInReplyTo(email: NormalizedEmail, store: ReplyTargetStore): Promise<ResolvableNudge | null> {
  const inReplyTo = parseInReplyTo(email);

  if (!inReplyTo) {
    return null;
  }

  return store.findNudgeByOutboundInReplyTo(inReplyTo);
}

/**
 * Extract the `In-Reply-To` provider message id from the email headers.
 * Header lookups are case-insensitive; values are commonly angle-bracketed.
 */
function parseInReplyTo(email: NormalizedEmail): string | null {
  const raw = email.headers["in-reply-to"] ?? email.headers["In-Reply-To"];

  if (!raw) {
    return null;
  }

  const trimmed = raw.trim().replace(/^<|>$/g, "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Hydrate the loops a nudge listed, ordered by their 1-based ordinal so that
 * "dismiss 1" maps to the loop the nudge actually presented as #1.
 */
async function loopsInOrdinalOrder(
  ordinalMap: PrivateReplyNudgeMetadata["ordinalMap"],
  store: ReplyTargetStore,
): Promise<PersistedLoop[]> {
  const orderedIds = Object.entries(ordinalMap)
    .map(([ordinal, loopId]) => ({ ordinal: Number(ordinal), loopId }))
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((entry) => entry.loopId);

  if (orderedIds.length === 0) {
    return [];
  }

  const loops = await store.findLoopsByIds(orderedIds);
  const byId = new Map(loops.map((loop) => [loop.id, loop]));

  return orderedIds.flatMap((loopId) => {
    const loop = byId.get(loopId);
    return loop ? [loop] : [];
  });
}
