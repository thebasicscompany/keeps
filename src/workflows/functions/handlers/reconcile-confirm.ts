import {
  mutateLoopState,
  type LoopProcessingRepository,
  type Phase2WorkflowEvent,
  type PrivateReplyNudgeMetadata,
} from "@/loops/service";
import type { ReconcileConfirmReply } from "@/loops/reconcile-reply";

/**
 * Phase 7 B2c — the ask-confirm reply handler.
 *
 * Closes the suppressed-duplicate reconciliation loop opened in B2b: when the capture
 * path was plausible-but-uncertain it persisted the new loop as 'suppressed' (hidden,
 * never nudged) and appended an ASK to the private reply ("…is this the same? Reply YES
 * to merge or NO to keep separate."). This handler applies the user's answer for EVERY
 * pending pair the originating nudge carried.
 *
 *   'same' (YES → merge):
 *     For each pair —
 *       • DISMISS the suppressed loop (mutateLoopState action 'dismiss'): the duplicate
 *         is folded away, never tracked on its own.
 *       • CONFIRM the candidate loop (action 'confirm'): advances the ORIGINAL commitment
 *         the user agreed this is the same as.
 *       • Write a 'superseded' loop_event on the suppressed loop with
 *         { supersededBy: candidateLoopId, confirmedByUser: true } so the merge is
 *         explainable in one sentence (AR-9: every reconciliation writes a loop_event).
 *
 *   'different' (NO → keep separate):
 *     For each pair —
 *       • CONFIRM the suppressed loop (action 'confirm' → status 'suppressed' → 'open'),
 *         promoting it to a normal tracked loop.
 *       • Write a 'reconciled' loop_event recording { keptSeparate: true, confirmedByUser:
 *         true } as provenance (we reuse the existing 'reconciled' eventType rather than
 *         introduce a new one — the decision IS a reconciliation outcome, just the
 *         keep-separate branch of it; the keptSeparate flag disambiguates from a merge).
 *
 * ALL loop state changes route through mutateLoopState (never hand-mutated). Never loses a
 * commitment: the suppressed loop is either absorbed (its candidate advanced) or promoted.
 *
 * `source` is 'auto_reconcile' (the existing reconciliation provenance tag) so the
 * loop_events.metadata source stays consistent with the auto-applied B2b reconciliations.
 */

export type HandleReconcileConfirmInput = {
  userId: string;
  /** The parsed YES/NO answer. */
  answer: ReconcileConfirmReply;
  /** The pending suppressed→candidate pairs carried on the originating nudge metadata. */
  pendingReconciliations: NonNullable<PrivateReplyNudgeMetadata["pendingReconciliations"]>;
  /** The replying user's free-text (for the commandText audit trail on mutateLoopState). */
  commandText: string;
  sourceInboundEmailId: string;
  repository: LoopProcessingRepository;
};

export type HandleReconcileConfirmResult = {
  outcome: "merged" | "kept_separate";
  /** loop.updated events for every mutation, in application order. */
  events: Phase2WorkflowEvent[];
  /** One-line reply body for the user. */
  reply: string;
};

export async function handleReconcileConfirm(
  input: HandleReconcileConfirmInput,
): Promise<HandleReconcileConfirmResult> {
  const { userId, answer, pendingReconciliations, commandText, sourceInboundEmailId, repository } = input;
  const events: Phase2WorkflowEvent[] = [];

  if (answer === "same") {
    for (const pair of pendingReconciliations) {
      // Fold the duplicate away …
      const dismissed = await mutateLoopState({
        userId,
        loopId: pair.suppressedLoopId,
        action: "dismiss",
        commandText: `Merged into existing loop (user confirmed same): ${commandText}`,
        source: "auto_reconcile",
        nextCheckAt: null,
        repository,
      });
      events.push(dismissed.event);

      // … and advance the original it merges into.
      const confirmed = await mutateLoopState({
        userId,
        loopId: pair.candidateLoopId,
        action: "confirm",
        commandText: `Advanced by confirmed merge: ${commandText}`,
        source: "auto_reconcile",
        nextCheckAt: null,
        repository,
      });
      events.push(confirmed.event);

      await repository.recordReconciliationEvent?.({
        userId,
        loopId: pair.suppressedLoopId,
        eventType: "superseded",
        metadata: {
          sourceInboundEmailId,
          supersededBy: pair.candidateLoopId,
          confirmedByUser: true,
        },
      });
    }

    return {
      outcome: "merged",
      events,
      reply: pluralize(
        pendingReconciliations.length,
        "Merged — I folded it into your existing loop.",
        "Merged — I folded them into your existing loops.",
      ),
    };
  }

  // answer === "different" → promote each suppressed loop to a normal tracked loop.
  for (const pair of pendingReconciliations) {
    const promoted = await mutateLoopState({
      userId,
      loopId: pair.suppressedLoopId,
      action: "confirm",
      commandText: `Kept separate (user confirmed different): ${commandText}`,
      source: "auto_reconcile",
      nextCheckAt: null,
      repository,
    });
    events.push(promoted.event);

    await repository.recordReconciliationEvent?.({
      userId,
      loopId: pair.suppressedLoopId,
      eventType: "reconciled",
      metadata: {
        sourceInboundEmailId,
        candidateLoopId: pair.candidateLoopId,
        keptSeparate: true,
        confirmedByUser: true,
      },
    });
  }

  return {
    outcome: "kept_separate",
    events,
    reply: pluralize(
      pendingReconciliations.length,
      "Got it — I'm tracking that as a separate loop.",
      "Got it — I'm tracking those as separate loops.",
    ),
  };
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}
