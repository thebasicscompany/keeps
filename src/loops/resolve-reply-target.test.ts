import { describe, expect, it } from "vitest";
import { normalizePostmarkInbound, type NormalizedEmail } from "@/email/normalize";
import { nudgeReplyPostmarkFixture } from "@/email/fixtures/postmark";
import {
  resolveReplyTarget,
  type ReplyTargetStore,
  type ResolvableNudge,
} from "@/loops/resolve-reply-target";
import type { PersistedLoop, PrivateReplyNudgeMetadata } from "@/loops/service";

const NUDGE_ID = "00000000-0000-0000-0000-000000000001";

function makeLoop(id: string, summary: string): PersistedLoop {
  return {
    id,
    userId: "user-1",
    emailThreadId: "thread-1",
    inboundEmailId: "inbound-1",
    sourceEvidenceId: `evidence-${id}`,
    status: "open",
    summary,
    sourceQuote: summary,
    confidence: 0.9,
    nextCheckAt: null,
  };
}

function makeMetadata(ordinalMap: Record<number, string>): PrivateReplyNudgeMetadata {
  return {
    kind: "private_reply",
    intent: "capture",
    loopCount: Object.keys(ordinalMap).length,
    lowConfidence: false,
    ordinalMap,
  };
}

class FakeReplyTargetStore implements ReplyTargetStore {
  byId = new Map<string, ResolvableNudge>();
  byInReplyTo = new Map<string, ResolvableNudge>();
  loops = new Map<string, PersistedLoop>();

  async findNudgeById(nudgeId: string): Promise<ResolvableNudge | null> {
    return this.byId.get(nudgeId) ?? null;
  }

  async findNudgeByOutboundInReplyTo(inReplyTo: string): Promise<ResolvableNudge | null> {
    return this.byInReplyTo.get(inReplyTo) ?? null;
  }

  async findLoopsByIds(loopIds: string[]): Promise<PersistedLoop[]> {
    return loopIds.flatMap((id) => {
      const loop = this.loops.get(id);
      return loop ? [loop] : [];
    });
  }
}

describe("resolveReplyTarget", () => {
  it("resolves via the mailbox hash (n_<uuid>) and returns loops ordered by ordinal", async () => {
    const store = new FakeReplyTargetStore();
    const loopOne = makeLoop("loop-a", "Send the renewal packet.");
    const loopTwo = makeLoop("loop-b", "Confirm the discount cap.");
    store.loops.set(loopOne.id, loopOne);
    store.loops.set(loopTwo.id, loopTwo);
    store.byId.set(NUDGE_ID, {
      id: NUDGE_ID,
      userId: "user-1",
      metadata: makeMetadata({ 1: loopOne.id, 2: loopTwo.id }),
    });

    const email = normalizePostmarkInbound(nudgeReplyPostmarkFixture);
    expect(email.mailboxHash).toBe(`n_${NUDGE_ID}`);

    const result = await resolveReplyTarget(email, { store });

    expect(result?.nudgeId).toBe(NUDGE_ID);
    expect(result?.loops.map((loop) => loop.id)).toEqual([loopOne.id, loopTwo.id]);
  });

  it("orders loops by their 1-based ordinal regardless of ordinalMap key order", async () => {
    const store = new FakeReplyTargetStore();
    const loopOne = makeLoop("loop-first", "First.");
    const loopTwo = makeLoop("loop-second", "Second.");
    store.loops.set(loopOne.id, loopOne);
    store.loops.set(loopTwo.id, loopTwo);
    store.byId.set(NUDGE_ID, {
      id: NUDGE_ID,
      userId: "user-1",
      // intentionally inserted out of order
      metadata: makeMetadata({ 2: loopTwo.id, 1: loopOne.id }),
    });

    const email = normalizePostmarkInbound(nudgeReplyPostmarkFixture);
    const result = await resolveReplyTarget(email, { store });

    expect(result?.loops.map((loop) => loop.id)).toEqual([loopOne.id, loopTwo.id]);
  });

  it("falls back to the In-Reply-To header when no mailbox hash is present", async () => {
    const store = new FakeReplyTargetStore();
    const loop = makeLoop("loop-c", "Follow up on pricing.");
    store.loops.set(loop.id, loop);
    store.byInReplyTo.set("dev-abc@keeps.local", {
      id: NUDGE_ID,
      userId: "user-1",
      metadata: makeMetadata({ 1: loop.id }),
    });

    const email: NormalizedEmail = {
      ...normalizePostmarkInbound(nudgeReplyPostmarkFixture),
      mailboxHash: null,
      headers: { "in-reply-to": "<dev-abc@keeps.local>" },
    };

    const result = await resolveReplyTarget(email, { store });

    expect(result?.nudgeId).toBe(NUDGE_ID);
    expect(result?.loops.map((loop) => loop.id)).toEqual([loop.id]);
  });

  it("returns null when neither the mailbox hash nor In-Reply-To resolves", async () => {
    const store = new FakeReplyTargetStore();

    const email: NormalizedEmail = {
      ...normalizePostmarkInbound(nudgeReplyPostmarkFixture),
      mailboxHash: null,
      headers: {},
    };

    expect(await resolveReplyTarget(email, { store })).toBeNull();
  });

  it("ignores a mailbox hash that is not in the n_<uuid> namespace", async () => {
    const store = new FakeReplyTargetStore();

    const email: NormalizedEmail = {
      ...normalizePostmarkInbound(nudgeReplyPostmarkFixture),
      mailboxHash: "digest_weekly",
      headers: {},
    };

    expect(await resolveReplyTarget(email, { store })).toBeNull();
  });
});
