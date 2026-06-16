/**
 * sweep-suppressed-timeout — daily Inngest cron (03:00 UTC).
 *
 * Promotes suppressed duplicates whose `reconcile_suggested` ask went unanswered
 * past the timeout (default 7 days) to independent OPEN loops, so a real
 * commitment is never silently lost while awaiting a yes/no. PROMOTES ONLY —
 * never dismisses (fail toward keeping the commitment).
 *
 * Inngest determinism: `now` is minted inside step.run. Repository-injectable for tests.
 */

import { inngest } from "@/workflows/client";

/** Narrow repository surface — satisfied structurally by DrizzleLoopProcessingRepository and by test fakes. */
export interface SuppressedTimeoutRepository {
  listSuppressedAwaitingConfirm(input: {
    userId?: string;
    olderThan: Date;
  }): Promise<Array<{ loopId: string; userId: string; suggestedAt: Date; candidateLoopId: string | null }>>;
  promoteSuppressedLoop(input: { loopId: string; userId: string; commandText: string }): Promise<void>;
}

export interface SweepSuppressedTimeoutOptions {
  repository: SuppressedTimeoutRepository;
  now: Date;
  /** Days a suppressed duplicate may await a yes/no before auto-promotion. Default 7. */
  timeoutDays?: number;
}

export interface SweepSuppressedTimeoutResult {
  promoted: number;
  loopIds: string[];
}

export async function sweepSuppressedTimeouts(
  options: SweepSuppressedTimeoutOptions,
): Promise<SweepSuppressedTimeoutResult> {
  const timeoutDays = options.timeoutDays ?? 7;
  const olderThan = new Date(options.now.getTime() - timeoutDays * 24 * 60 * 60 * 1000);

  const candidates = await options.repository.listSuppressedAwaitingConfirm({ olderThan });

  const loopIds: string[] = [];
  for (const candidate of candidates) {
    await options.repository.promoteSuppressedLoop({
      loopId: candidate.loopId,
      userId: candidate.userId,
      commandText: `auto-promoted: no reply within ${timeoutDays}d`,
    });
    loopIds.push(candidate.loopId);
  }

  return { promoted: loopIds.length, loopIds };
}

export const sweepSuppressedTimeoutFunction = inngest.createFunction(
  { id: "sweep-suppressed-timeout", triggers: { cron: "0 3 * * *" }, retries: 1 },
  async ({ step }) => {
    const result = await step.run("sweep-suppressed-timeouts", async () => {
      const { DrizzleLoopProcessingRepository } = await import("@/loops/repository");
      const repository = new DrizzleLoopProcessingRepository();
      return sweepSuppressedTimeouts({ repository, now: new Date() });
    });
    console.log(`[sweep-suppressed-timeout] promoted=${result.promoted}`);
    return result;
  },
);
