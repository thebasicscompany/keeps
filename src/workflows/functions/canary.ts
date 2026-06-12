import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getEnv } from "@/config/env";
import { getDb } from "@/db/client";
import { inboundEmails, loops, nudges } from "@/db/schema";
import { inngest } from "@/workflows/client";

/**
 * The canary user is a real verified `users` row seeded in prod whose address is
 * Postmark's blackhole: sends to it are accepted and discarded — no bounce (which
 * would hurt sender reputation) and, critically, no delivery back into our own apex
 * MX (which would re-enter the inbound webhook).
 */
export const CANARY_USER_EMAIL = "test@blackhole.postmarkapp.com";

/** Builds the synthetic Postmark inbound payload for one canary run. Pure for tests. */
export function buildCanaryPayload(marker: string) {
  return {
    MessageID: marker,
    MailboxHash: "",
    From: `Keeps Canary <${CANARY_USER_EMAIL}>`,
    FromFull: { Email: CANARY_USER_EMAIL, Name: "Keeps Canary", MailboxHash: "" },
    To: "agent@keeps.email",
    ToFull: [{ Email: "agent@keeps.email", Name: "Keeps", MailboxHash: "" }],
    Cc: "",
    CcFull: [],
    Bcc: "",
    Subject: `Canary ${marker}`,
    TextBody: "I'll send the canary verification report by Friday.",
    HtmlBody: "",
    StrippedTextReply: "",
    Date: new Date().toISOString(),
    Headers: [{ Name: "Message-ID", Value: `<${marker}@canary.keeps.email>` }],
    Attachments: [],
  };
}

/**
 * Silent-failure rail: pushes a synthetic email through the entire real production
 * pipeline (webhook auth -> persistence -> Inngest event -> extraction -> nudge send)
 * and throws if any stage doesn't complete. The throw surfaces through
 * `inngest/function.failed`, which the alert function emails out — the canary's only
 * job is to convert silence into a loud failure.
 *
 * Known limitations, accepted for v1:
 * - Runs on the same Inngest installation it monitors; a total Inngest outage also
 *   silences the canary (external dead-man's switch closes this later).
 * - Each run consumes one real Postmark send and one model extraction call. Daily
 *   cadence keeps that inside the free Postmark tier; raise after upgrading.
 */
export const pipelineCanary = inngest.createFunction(
  { id: "pipeline-canary", triggers: { cron: "0 13 * * *" }, retries: 0 },
  async ({ step }) => {
    const marker = `canary-${randomUUID()}`;

    await step.run("post-synthetic-inbound", async () => {
      const env = getEnv();

      if (!env.KEEPS_INBOUND_WEBHOOK_SECRET) {
        throw new Error("canary: KEEPS_INBOUND_WEBHOOK_SECRET is not configured.");
      }

      const response = await fetch(`${env.NEXT_PUBLIC_APP_URL}/api/email/inbound`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`keeps:${env.KEEPS_INBOUND_WEBHOOK_SECRET}`).toString("base64")}`,
        },
        body: JSON.stringify(buildCanaryPayload(marker)),
      });

      const body = await response.json();

      if (response.status !== 202 || body.status !== "sender_verified") {
        throw new Error(
          `canary: inbound webhook returned ${response.status} / ${body.status ?? "no status"} — expected 202 / sender_verified. Is the canary user seeded and verified?`,
        );
      }

      return { marker };
    });

    // Extraction (model call) typically completes in well under a minute; one generous
    // wait keeps the canary simple. The sleep is durable, so a slow run costs nothing.
    await step.sleep("await-pipeline", "90s");

    const outcome = await step.run("verify-loop-and-nudge", async () => {
      const db = getDb();

      const [inbound] = await db
        .select({ id: inboundEmails.id })
        .from(inboundEmails)
        .where(eq(inboundEmails.providerMessageId, marker))
        .limit(1);

      if (!inbound) {
        throw new Error(`canary: no inbound_emails row for marker ${marker} — webhook persistence failed.`);
      }

      const extractedLoops = await db
        .select({ id: loops.id })
        .from(loops)
        .where(eq(loops.inboundEmailId, inbound.id));

      if (extractedLoops.length === 0) {
        throw new Error(
          `canary: inbound ${inbound.id} produced no loops after 90s — process-email did not run or extraction failed. Check Inngest sync and OpenAI.`,
        );
      }

      const [nudge] = await db
        .select({ id: nudges.id, status: nudges.status })
        .from(nudges)
        .where(and(eq(nudges.inboundEmailId, inbound.id), eq(nudges.status, "sent")))
        .limit(1);

      if (!nudge) {
        throw new Error(`canary: loops extracted for ${inbound.id} but no nudge reached status=sent — outbound transport failed.`);
      }

      return { inboundEmailId: inbound.id, loopIds: extractedLoops.map((loop) => loop.id) };
    });

    // Dismiss the canary's loops so they never accumulate as open work for the canary
    // user (Phase 3's nudge sweep would otherwise re-nudge them forever).
    await step.run("dismiss-canary-loops", async () => {
      const db = getDb();
      await db.update(loops).set({ status: "dismissed" }).where(inArray(loops.id, outcome.loopIds));
      return { dismissed: outcome.loopIds.length };
    });

    return { ok: true, marker, ...outcome };
  },
);
