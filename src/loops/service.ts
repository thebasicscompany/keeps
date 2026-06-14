import type { LoopCandidate, LoopStatus, ProposedLoopStatus } from "@/agent/schemas";
import { extractLoops } from "@/agent/extract-loops";
import { prepareEmailForExtraction } from "@/email/extraction-body";
import type { NormalizedEmail } from "@/email/normalize";
import { parseLoopReplyCommand, type LoopReplyCommand } from "@/loops/commands";
import { buildPrivateLoopReply } from "@/loops/replies";
import type { ExtractionContext } from "@/agent/extraction-context";
import {
  decideReconciliation,
  type ReconcileDecision,
} from "@/agent/reconcile";

export const highConfidenceLoopThreshold = 0.7;

export type ProcessableInboundEmail = {
  id: string;
  userId: string;
  emailThreadId: string;
  emailMessageId: string | null;
  normalized: NormalizedEmail;
};

// Widened to the FULL LoopStatus (incl. 'suppressed') so the reconciliation
// decider's `ask` outcome can persist a suppressed loop. `Omit` is required:
// a plain `LoopCandidate & { status: LoopStatus }` intersects to the NARROW
// ProposedLoopStatus (LoopCandidate already declares `status`), which would
// reject 'suppressed'. The model still only proposes the narrow status; only
// the decider assigns 'suppressed'.
export type LoopToPersist = Omit<LoopCandidate, "status"> & {
  status: LoopStatus;
};

/**
 * Phase 7 B2b — the result of loading reconciliation context for one inbound
 * email. Superset of B3's ExtractionContext: also exposes the inbound email's
 * resolved participant entity ids so the structural `sameEntity` check can
 * intersect them against each candidate loop's entityIds.
 */
export type OpenLoopContext = ExtractionContext & {
  participantEntityIds: string[];
};

export type PersistedLoop = {
  id: string;
  userId: string;
  emailThreadId: string;
  inboundEmailId: string;
  sourceEvidenceId: string;
  status: LoopStatus;
  summary: string;
  sourceQuote: string;
  confidence: number;
  nextCheckAt: Date | null;
};

export type PersistedNudge = {
  id: string;
  userId: string;
  inboundEmailId: string | null;
  body: string;
};

export type PrivateReplyNudgeMetadata = {
  kind: "private_reply";
  intent: string;
  loopCount: number;
  lowConfidence: boolean;
  /** 1-based ordinal (as listed in the reply body) → loop id. */
  ordinalMap: Record<number, string>;
  /**
   * Present only on approval nudges (nudge_type 'approval'): the approval_request id
   * this nudge requested a decision on. The C4 router dispatches a reply to the
   * approval handler whenever this is set, REGARDLESS of the classified intent
   * (nudge-type dispatch precedes intent dispatch — AR-3 gotcha 6). Capture/command/
   * digest nudges never carry it. Additive + optional so older nudges and every
   * existing fake remain valid.
   */
  approvalId?: string | null;
  /**
   * The originating nudge's type, when known ('digest' for digest nudges). Lets the
   * router treat a digest reply's free-text fallthrough as a capture (AR-9). Optional
   * so non-digest nudges and pre-C4 fakes are unaffected.
   */
  nudgeType?: string;
  /**
   * Phase 7 B2c — the suppressed-duplicate reconciliation asks this nudge posed. Each
   * pair links the freshly-persisted SUPPRESSED loop to the existing CANDIDATE loop it
   * might merge into. When the user replies YES/NO to this nudge, the router resolves
   * the pending pairs off this field (nudge-type dispatch precedes intent dispatch — the
   * same precedence rule as `approvalId`) and applies the merge / keep-separate.
   *
   * Additive + optional so every existing nudge and in-memory fake stays valid; absent
   * or empty → the reconcile-confirm dispatch never fires and YES/NO falls through to
   * normal intent handling.
   */
  pendingReconciliations?: { suppressedLoopId: string; candidateLoopId: string }[];
};

export type LoopProcessingRepository = {
  findInboundEmailById(inboundEmailId: string): Promise<ProcessableInboundEmail | null>;
  /**
   * Persistence-level idempotency guard (Deliverable 11): the loops already extracted
   * for this inbound email, if any. A non-empty result means capture already ran for
   * this `inboundEmailId`, so the capture branch returns `already_processed` and skips
   * re-extraction and nudge creation.
   */
  findLoopsByInboundEmailId(inboundEmailId: string): Promise<PersistedLoop[]>;
  persistExtractedLoops(input: {
    email: ProcessableInboundEmail;
    loops: LoopToPersist[];
    normalizedBody: string;
  }): Promise<PersistedLoop[]>;
  createPrivateReplyNudge(input: {
    userId: string;
    inboundEmailId: string;
    subject: string;
    body: string;
    metadata: PrivateReplyNudgeMetadata;
  }): Promise<PersistedNudge>;
  /**
   * Creates a plain private-reply nudge for non-capture branches (command result,
   * correction ack, question/approval stubs). Carries an empty `ordinalMap` because
   * these replies do not list loops the user can address by ordinal.
   */
  createReplyNudge(input: {
    userId: string;
    inboundEmailId: string;
    subject: string;
    body: string;
    intent: string;
  }): Promise<PersistedNudge>;
  listCommandableLoops(input: { userId: string; emailThreadId?: string | null }): Promise<PersistedLoop[]>;
  updateLoopFromCommand(input: {
    loopId: string;
    userId: string;
    status: LoopStatus;
    nextCheckAt?: Date | null;
    commandText: string;
    eventType: "confirmed" | "dismissed" | "snoozed" | "marked_done";
    /** Discriminates the originating path for loop_events.metadata. Defaults to "email_command". */
    source?: "email_command" | "report_row_action" | "auto_reconcile";
  }): Promise<PersistedLoop>;
  /**
   * Correction branch (Deliverable 5): record the user's correction text against a loop
   * as a `loop_events.event_type = 'corrected'` row. Real re-extraction is Phase 3.
   */
  recordLoopCorrection(input: { userId: string; loopId: string; commandText: string }): Promise<void>;
  /**
   * Returns the user's IANA timezone string (C4 / Deliverable #15). Used to resolve
   * "snooze N until Monday" replies to 9 AM in the user's local zone. Returns null
   * when the user has no timezone set; callers then fall back to UTC behavior.
   *
   * OPTIONAL on the port so pre-C4 in-memory fakes (which never set a timezone)
   * remain valid implementations without modification — the router treats a
   * missing method exactly like a null result (UTC fallback).
   */
  findUserTimezone?(userId: string): Promise<string | null>;
  /**
   * Phase 7 B2b — load the reconciliation candidate set (open loops + known
   * entities) plus the inbound email's resolved participant entity ids, for
   * context-aware extraction + the three-band decider.
   *
   * OPTIONAL on the port so every pre-B2b in-memory fake remains a valid
   * implementation without modification. When the method is ABSENT, the capture
   * path runs with EMPTY context — the decider returns `create` for everything
   * and behavior is byte-for-byte unchanged (backward-compat invariant).
   */
  loadOpenLoopContext?(input: {
    userId: string;
    threadId: string | null;
    participants: { name: string | null; email: string | null }[];
    queryText: string | null;
  }): Promise<OpenLoopContext>;
  /**
   * Phase 7 B2b — write a reconciliation provenance loop_event (AR-9). Used for
   * both `reconciled` (auto update/close) and `reconcile_suggested` (ask) so the
   * decision is explainable in one sentence and the later confirm-reply handler
   * can find suppressed loops by their `reconcile_suggested` event.
   *
   * OPTIONAL so pre-B2b fakes remain valid; the service treats a missing method
   * as a no-op (the provenance write is best-effort enrichment, never a
   * commitment, and a fake without it simply records nothing).
   */
  recordReconciliationEvent?(input: {
    userId: string;
    loopId: string;
    // Widened in B2c to also allow 'superseded' — written on a suppressed loop when the
    // user confirms (YES) it is the same commitment as the candidate it merges into.
    eventType: "reconciled" | "reconcile_suggested" | "superseded";
    metadata: Record<string, unknown>;
  }): Promise<void>;
};

export type Phase2WorkflowEvent =
  | {
      name: "email.classified";
      data: {
        inboundEmailId: string;
        emailThreadId: string;
        userId: string;
        intent: string;
        /** Dispatched branch; mirrors `intent` today, kept distinct for multi-intent emails. */
        branch: string;
        loopCount: number;
      };
    }
  | {
      name: "loops.extracted";
      data: {
        inboundEmailId: string;
        emailThreadId: string;
        userId: string;
        loopCount: number;
        lowConfidence: boolean;
      };
    }
  | {
      name: "loop.created";
      data: {
        loopId: string;
        inboundEmailId: string;
        emailThreadId: string;
        userId: string;
        status: LoopStatus;
        sourceEvidenceId: string;
      };
    }
  | {
      name: "loop.updated";
      data: {
        loopId: string;
        userId: string;
        status: LoopStatus;
        eventType: "confirmed" | "dismissed" | "snoozed" | "marked_done";
      };
    };

export type LoopMutationAction = "confirm" | "dismiss" | "snooze" | "mark_done";

export type MutateLoopStateInput = {
  userId: string;
  loopId: string;
  action: LoopMutationAction;
  /** Required for snooze (the new next_check_at); ignored otherwise. */
  snoozeUntil?: Date | null;
  /** For non-snooze actions, the loop's current nextCheckAt so it is preserved unchanged. */
  nextCheckAt?: Date | null;
  commandText: string;
  source: "email_command" | "report_row_action" | "auto_reconcile";
  repository: LoopProcessingRepository;
};

export type MutateLoopStateResult = {
  loop: PersistedLoop;
  event: Extract<Phase2WorkflowEvent, { name: "loop.updated" }>;
};

export async function mutateLoopState(input: MutateLoopStateInput): Promise<MutateLoopStateResult> {
  const status = statusForAction(input.action);
  const eventType = eventTypeForAction(input.action);
  const nextCheckAt = input.action === "snooze" ? (input.snoozeUntil ?? null) : input.nextCheckAt;

  const loop = await input.repository.updateLoopFromCommand({
    loopId: input.loopId,
    userId: input.userId,
    status,
    nextCheckAt,
    commandText: input.commandText,
    eventType,
    source: input.source,
  });

  const event: Extract<Phase2WorkflowEvent, { name: "loop.updated" }> = {
    name: "loop.updated",
    data: {
      loopId: loop.id,
      userId: loop.userId,
      status: loop.status,
      eventType,
    },
  };

  return { loop, event };
}

/**
 * Phase 7 B2b — an auto-applied reconciliation (the decider AUTO-updated or
 * AUTO-closed an existing loop instead of creating a new one). Additive result
 * field so D2 / tests can surface provenance.
 */
export type AppliedReconciliation = {
  loopId: string;
  action: "update" | "close";
  /** The mutated loop after mutateLoopState ran. */
  loop: PersistedLoop;
  evidence: string;
  reason: string;
  /** The summary of the freshly-extracted loop that was absorbed into the existing one. */
  absorbedSummary: string;
};

/**
 * Phase 7 B2b — a reconciliation the decider downgraded to ASK. The new loop is
 * persisted SUPPRESSED (never lost, never nudged, not shown as open) and a
 * `reconcile_suggested` provenance event is written so the later confirm-reply
 * handler can find it. `askText` is surfaced in the private reply.
 */
export type SuggestedReconciliation = {
  /** The newly-persisted suppressed loop. */
  loop: PersistedLoop;
  /** The existing candidate loop id the new loop might merge into. */
  candidateLoopId: string;
  evidence: string;
  reason: string;
  askText: string;
};

export type ProcessInboundEmailForLoopsResult =
  | {
      status: "processed";
      inboundEmailId: string;
      intent: string;
      loops: PersistedLoop[];
      /** Auto-applied reconciliations (update/close) — these did NOT create a new loop. */
      reconciliations: AppliedReconciliation[];
      /** Suppressed (ask) loops awaiting user confirmation to merge. */
      suggestedReconciliations: SuggestedReconciliation[];
      privateReply: string;
      nudgeId: string;
      events: Phase2WorkflowEvent[];
    }
  | {
      status: "already_processed";
      inboundEmailId: string;
      loops: PersistedLoop[];
      events: Phase2WorkflowEvent[];
    }
  | {
      status: "missing_inbound_email";
      inboundEmailId: string;
      events: Phase2WorkflowEvent[];
    };

export async function processInboundEmailForLoops(input: {
  inboundEmailId: string;
  repository: LoopProcessingRepository;
  useModel?: boolean;
}): Promise<ProcessInboundEmailForLoopsResult> {
  const email = await input.repository.findInboundEmailById(input.inboundEmailId);

  if (!email) {
    return {
      status: "missing_inbound_email",
      inboundEmailId: input.inboundEmailId,
      events: [],
    };
  }

  // Persistence-level idempotency guard (Deliverable 11): if loops already exist for
  // this inbound email, capture already ran. Skip re-extraction and nudge creation so a
  // replayed `email.received` creates zero new rows and emits no `loop.created`.
  const existingLoops = await input.repository.findLoopsByInboundEmailId(email.id);

  if (existingLoops.length > 0) {
    return {
      status: "already_processed",
      inboundEmailId: email.id,
      loops: existingLoops,
      events: [],
    };
  }

  const extractionBody = prepareEmailForExtraction(email.normalized);

  // ── Phase 7 B2b: load reconciliation context (open loops + known entities +
  // the inbound email's resolved participant entity ids). When the repo doesn't
  // implement loadOpenLoopContext (every pre-B2b fake), context is EMPTY and the
  // decider returns `create` for everything — byte-for-byte legacy behavior.
  const context = await loadCaptureContext(email, extractionBody.normalizedBody, input.repository);

  const extraction = await extractLoops({
    email: email.normalized,
    useModel: input.useModel,
    context: { openLoops: context.openLoops, knownEntities: context.knownEntities },
  });

  // ── Partition extracted loops by the three-band decider. ────────────────────
  // refId → candidate CompactLoop for O(1) resolution.
  const candidateByRef = new Map(context.openLoops.map((loop) => [loop.refId, loop]));
  const participantEntityIdSet = new Set(context.participantEntityIds);

  const toCreate: LoopToPersist[] = [];
  // Reconcile/ask decisions are applied AFTER the create-persist so we never
  // accidentally mutate something mid-create; each carries the originating loop.
  const reconcileDecisions: Array<{
    decision: Extract<ReconcileDecision, { kind: "reconcile" }>;
    loop: LoopCandidate;
  }> = [];
  const askDecisions: Array<{
    decision: Extract<ReconcileDecision, { kind: "ask" }>;
    loop: LoopCandidate;
  }> = [];

  for (const loop of extraction.loops) {
    const candidateCompact = loop.reconcilesLoopRef
      ? candidateByRef.get(loop.reconcilesLoopRef) ?? null
      : null;

    const decision = decideReconciliation({
      proposal: {
        reconcilesLoopRef: loop.reconcilesLoopRef,
        reconcileAction: loop.reconcileAction,
        reconcileConfidence: loop.reconcileConfidence,
        reconcileEvidence: loop.reconcileEvidence,
      },
      candidate: candidateCompact
        ? { id: candidateCompact.id, refId: candidateCompact.refId, summary: candidateCompact.summary }
        : null,
      structural: {
        newLoopSummary: loop.summary,
        sameThread: candidateCompact ? candidateCompact.emailThreadId === email.emailThreadId : false,
        sameEntity: candidateCompact
          ? candidateCompact.entityIds.some((id) => participantEntityIdSet.has(id))
          : false,
      },
    });

    if (decision.kind === "create") {
      toCreate.push({ ...loop, status: chooseInitialLoopStatus(loop) });
    } else if (decision.kind === "reconcile") {
      reconcileDecisions.push({ decision, loop });
    } else {
      askDecisions.push({ decision, loop });
    }
  }

  // ── Persist the CREATE set (today's behavior, unchanged). ───────────────────
  const persistedLoops = await input.repository.persistExtractedLoops({
    email,
    loops: toCreate,
    normalizedBody: extractionBody.normalizedBody,
  });

  // ── Apply RECONCILE decisions: mutate the existing loop + write provenance. ──
  // Never creates a new loop (cardinal: never lose a commitment — the existing
  // loop is advanced/closed, the extracted one is absorbed into it).
  const reconciliations: AppliedReconciliation[] = [];
  for (const { decision, loop } of reconcileDecisions) {
    const action = decision.action === "close" ? "mark_done" : "confirm";
    const { loop: mutated } = await mutateLoopState({
      loopId: decision.loopId,
      userId: email.userId,
      action,
      commandText:
        decision.action === "close"
          ? `Auto-closed by reconciliation: ${loop.summary}`
          : `Auto-advanced by reconciliation: ${loop.summary}`,
      source: "auto_reconcile",
      nextCheckAt: null,
      repository: input.repository,
    });

    await input.repository.recordReconciliationEvent?.({
      userId: email.userId,
      loopId: decision.loopId,
      eventType: "reconciled",
      metadata: {
        sourceInboundEmailId: email.id,
        action: decision.action,
        evidence: decision.evidence,
        reason: decision.reason,
        absorbedSummary: loop.summary,
      },
    });

    reconciliations.push({
      loopId: decision.loopId,
      action: decision.action,
      loop: mutated,
      evidence: decision.evidence,
      reason: decision.reason,
      absorbedSummary: loop.summary,
    });
  }

  // ── Apply ASK decisions: persist a SUPPRESSED loop (never lost) + provenance.
  // The suppressed loop is hidden, not nudged, not shown as open. A
  // `reconcile_suggested` event lets the later confirm-reply handler find it.
  const suggestedReconciliations: SuggestedReconciliation[] = [];
  for (const { decision, loop } of askDecisions) {
    const candidateCompact = context.openLoops.find((openLoop) => openLoop.id === decision.loopId) ?? null;
    const candidateSummary = candidateCompact?.summary ?? "your existing loop";

    const suppressedToPersist: LoopToPersist = { ...loop, status: "suppressed" };
    const [suppressedLoop] = await input.repository.persistExtractedLoops({
      email,
      loops: [suppressedToPersist],
      normalizedBody: extractionBody.normalizedBody,
    });

    await input.repository.recordReconciliationEvent?.({
      userId: email.userId,
      loopId: suppressedLoop.id,
      eventType: "reconcile_suggested",
      metadata: {
        sourceInboundEmailId: email.id,
        candidateLoopId: decision.loopId,
        candidateSummary,
        evidence: decision.evidence,
        reason: decision.reason,
        suggestedSummary: loop.summary,
      },
    });

    suggestedReconciliations.push({
      loop: suppressedLoop,
      candidateLoopId: decision.loopId,
      evidence: decision.evidence,
      reason: decision.reason,
      askText: `Looks like your existing loop about "${candidateSummary}" — is this the same? Reply YES to merge or NO to keep separate.`,
    });
  }

  // ── Private reply. Only the CREATE (non-suppressed) loops count toward the
  // normal loop list / ordinalMap / low-confidence logic; suppressed loops and
  // reconciliations are surfaced as additive context, never inflating the list.
  const baseReply = buildPrivateLoopReply({
    extraction,
    loops: persistedLoops.map((loop, index) => ({
      ordinal: index + 1,
      summary: loop.summary,
      sourceQuote: loop.sourceQuote,
      confidence: loop.confidence,
    })),
  });

  const replyExtras: string[] = [];
  for (const reconciliation of reconciliations) {
    replyExtras.push(
      reconciliation.action === "close"
        ? `Closed your existing loop about "${reconciliation.loop.summary}".`
        : `Advanced your existing loop about "${reconciliation.loop.summary}".`,
    );
  }
  for (const ask of suggestedReconciliations) {
    replyExtras.push(ask.askText);
  }
  const privateReply = replyExtras.length > 0 ? [baseReply, "", ...replyExtras].join("\n") : baseReply;

  // low-confidence reflects only the CREATE set, exactly as before.
  const lowConfidence = toCreate.length > 0 && toCreate.every((loop) => loop.confidence < highConfidenceLoopThreshold);
  const nudge = await input.repository.createPrivateReplyNudge({
    userId: email.userId,
    inboundEmailId: email.id,
    subject: replySubject(email.normalized.subject),
    body: privateReply,
    metadata: {
      kind: "private_reply",
      intent: extraction.intent,
      loopCount: persistedLoops.length,
      lowConfidence,
      // 1-based ordinal → loop id, ordered exactly as the loops are listed in the reply body.
      // Suppressed loops are excluded — they are not addressable by ordinal.
      ordinalMap: Object.fromEntries(persistedLoops.map((loop, index) => [index + 1, loop.id])),
      // Phase 7 B2c — carry the suppressed-duplicate asks so a YES/NO reply to THIS nudge
      // can be resolved to its pending pairs. Empty when there were no asks (additive).
      pendingReconciliations: suggestedReconciliations.map((suggestion) => ({
        suppressedLoopId: suggestion.loop.id,
        candidateLoopId: suggestion.candidateLoopId,
      })),
    },
  });
  const events: Phase2WorkflowEvent[] = [
    {
      name: "email.classified",
      data: {
        inboundEmailId: email.id,
        emailThreadId: email.emailThreadId,
        userId: email.userId,
        intent: extraction.intent,
        branch: "capture",
        loopCount: extraction.loops.length,
      },
    },
    {
      name: "loops.extracted",
      data: {
        inboundEmailId: email.id,
        emailThreadId: email.emailThreadId,
        userId: email.userId,
        loopCount: persistedLoops.length,
        lowConfidence,
      },
    },
    ...persistedLoops.map(
      (loop): Phase2WorkflowEvent => ({
        name: "loop.created",
        data: {
          loopId: loop.id,
          inboundEmailId: loop.inboundEmailId,
          emailThreadId: loop.emailThreadId,
          userId: loop.userId,
          status: loop.status,
          sourceEvidenceId: loop.sourceEvidenceId,
        },
      }),
    ),
    ...reconciliations.map(
      (reconciliation): Phase2WorkflowEvent => ({
        name: "loop.updated",
        data: {
          loopId: reconciliation.loop.id,
          userId: reconciliation.loop.userId,
          status: reconciliation.loop.status,
          eventType: reconciliation.action === "close" ? "marked_done" : "confirmed",
        },
      }),
    ),
  ];

  return {
    status: "processed",
    inboundEmailId: email.id,
    intent: extraction.intent,
    loops: persistedLoops,
    reconciliations,
    suggestedReconciliations,
    privateReply,
    nudgeId: nudge.id,
    events,
  };
}

/**
 * Load the reconciliation context for the capture path. Falls back to EMPTY
 * context (all-creates, legacy behavior) when the repository does not implement
 * loadOpenLoopContext — the common case for in-memory fakes and the backward-
 * compat guarantee.
 */
async function loadCaptureContext(
  email: ProcessableInboundEmail,
  normalizedBody: string,
  repository: LoopProcessingRepository,
): Promise<OpenLoopContext> {
  if (!repository.loadOpenLoopContext) {
    return { openLoops: [], knownEntities: [], participantEntityIds: [] };
  }

  const participants = [
    { name: email.normalized.from.name, email: email.normalized.from.email },
    ...email.normalized.to.map((address) => ({ name: address.name, email: address.email })),
    ...email.normalized.cc.map((address) => ({ name: address.name, email: address.email })),
  ];
  const snippet = normalizedBody.slice(0, 200);
  const queryText = `${email.normalized.subject} ${snippet}`.trim();

  return repository.loadOpenLoopContext({
    userId: email.userId,
    threadId: email.emailThreadId,
    participants,
    queryText: queryText.length > 0 ? queryText : null,
  });
}

export type ApplyLoopReplyCommandResult = {
  command: LoopReplyCommand;
  updatedLoops: PersistedLoop[];
  reply: string;
  events: Phase2WorkflowEvent[];
};

export async function applyLoopReplyCommand(input: {
  userId: string;
  emailThreadId?: string | null;
  text: string;
  repository: LoopProcessingRepository;
  now?: Date;
  /**
   * The replying user's IANA timezone. When provided, "snooze N until Monday" /
   * "remind me tomorrow" resolve to 9 AM in this zone (Deliverable #15). Omitted
   * or unknown → the legacy UTC reminder behavior, so existing callers are
   * byte-for-byte unaffected.
   */
  timezone?: string;
  /**
   * Loops the command should operate over, preloaded from the source nudge's
   * `metadata.ordinalMap` (see C2 command branch). When provided, the nudge-scoped
   * list is authoritative and `listCommandableLoops` is skipped entirely, so
   * "dismiss 1" resolves to the loop the nudge listed as #1 — even if newer loops
   * exist. Omit it to fall back to live re-listing (used by digest commands).
   */
  loops?: PersistedLoop[];
}): Promise<ApplyLoopReplyCommandResult> {
  const command = parseLoopReplyCommand(input.text, { now: input.now, timezone: input.timezone });
  const commandableLoops =
    input.loops ??
    (await input.repository.listCommandableLoops({
      userId: input.userId,
      emailThreadId: input.emailThreadId,
    }));

  if (command.type === "unknown") {
    return {
      command,
      updatedLoops: [],
      reply: "I did not understand that loop command.",
      events: [],
    };
  }

  if (command.type === "correction") {
    return {
      command,
      updatedLoops: [],
      reply: command.correctionText
        ? "Got it. I will use that correction before updating the loop."
        : "Reply with the corrected loop text.",
      events: [],
    };
  }

  const targets = selectCommandTargets(command, commandableLoops);

  if (targets.length === 0) {
    return {
      command,
      updatedLoops: [],
      reply: "I could not find that loop number.",
      events: [],
    };
  }

  if (command.type === "snooze" && !command.remindAt) {
    return {
      command,
      updatedLoops: [],
      reply: `I could not understand "${command.remindAtText}" as a reminder date.`,
      events: [],
    };
  }

  const updatedLoops: PersistedLoop[] = [];
  const events: Phase2WorkflowEvent[] = [];

  for (const target of targets) {
    const result = await mutateLoopState({
      userId: input.userId,
      loopId: target.id,
      action: command.type as LoopMutationAction,
      snoozeUntil: command.type === "snooze" ? command.remindAt : undefined,
      nextCheckAt: target.nextCheckAt,
      commandText: command.rawText,
      source: "email_command",
      repository: input.repository,
    });
    updatedLoops.push(result.loop);
    events.push(result.event);
  }

  return {
    command,
    updatedLoops,
    reply: replyForCommand(command, updatedLoops.length),
    events,
  };
}

function chooseInitialLoopStatus(loop: LoopCandidate): ProposedLoopStatus {
  return loop.confidence >= highConfidenceLoopThreshold ? "open" : "candidate";
}

function selectCommandTargets(command: LoopReplyCommand, loops: PersistedLoop[]): PersistedLoop[] {
  if (command.type === "confirm") {
    return loops.filter((loop) => loop.status === "candidate");
  }

  if (command.type === "snooze" && command.loopOrdinal === null) {
    return loops;
  }

  if ("loopOrdinal" in command && command.loopOrdinal !== null) {
    const target = loops[command.loopOrdinal - 1];
    return target ? [target] : [];
  }

  return [];
}

function statusForAction(action: LoopMutationAction): LoopStatus {
  switch (action) {
    case "confirm":
      return "open";
    case "dismiss":
      return "dismissed";
    case "snooze":
      return "snoozed";
    case "mark_done":
      return "done";
  }
}

function eventTypeForAction(action: LoopMutationAction): "confirmed" | "dismissed" | "snoozed" | "marked_done" {
  switch (action) {
    case "confirm":
      return "confirmed";
    case "dismiss":
      return "dismissed";
    case "snooze":
      return "snoozed";
    case "mark_done":
      return "marked_done";
  }
}

function statusForCommand(command: Exclude<LoopReplyCommand, { type: "unknown" | "correction" }>): LoopStatus {
  return statusForAction(command.type);
}

function eventTypeForCommand(
  command: Exclude<LoopReplyCommand, { type: "unknown" | "correction" }>,
): "confirmed" | "dismissed" | "snoozed" | "marked_done" {
  return eventTypeForAction(command.type);
}

function replyForCommand(command: Exclude<LoopReplyCommand, { type: "unknown" | "correction" }>, count: number): string {
  switch (command.type) {
    case "confirm":
      return `Confirmed ${count} loop${count === 1 ? "" : "s"}.`;
    case "dismiss":
      return "Dismissed.";
    case "snooze":
      return "Reminder updated.";
    case "mark_done":
      return "Marked done.";
  }
}

function replySubject(subject: string): string {
  return subject ? `Re: ${subject}` : "Re: your Keeps loop";
}
