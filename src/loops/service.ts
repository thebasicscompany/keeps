import type { LoopCandidate, LoopStatus } from "@/agent/schemas";
import { extractLoops } from "@/agent/extract-loops";
import { prepareEmailForExtraction } from "@/email/extraction-body";
import type { NormalizedEmail } from "@/email/normalize";
import { parseLoopReplyCommand, type LoopReplyCommand } from "@/loops/commands";
import { buildPrivateLoopReply } from "@/loops/replies";

export const highConfidenceLoopThreshold = 0.7;

export type ProcessableInboundEmail = {
  id: string;
  userId: string;
  emailThreadId: string;
  emailMessageId: string | null;
  normalized: NormalizedEmail;
};

export type LoopToPersist = LoopCandidate & {
  status: LoopStatus;
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
    source?: "email_command" | "report_row_action";
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
  source: "email_command" | "report_row_action";
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

export type ProcessInboundEmailForLoopsResult =
  | {
      status: "processed";
      inboundEmailId: string;
      intent: string;
      loops: PersistedLoop[];
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
  const extraction = await extractLoops({
    email: email.normalized,
    useModel: input.useModel,
  });
  const loopsToPersist = extraction.loops.map((loop): LoopToPersist => ({
    ...loop,
    status: chooseInitialLoopStatus(loop),
  }));
  const persistedLoops = await input.repository.persistExtractedLoops({
    email,
    loops: loopsToPersist,
    normalizedBody: extractionBody.normalizedBody,
  });
  const privateReply = buildPrivateLoopReply({
    extraction,
    loops: persistedLoops.map((loop, index) => ({
      ordinal: index + 1,
      summary: loop.summary,
      sourceQuote: loop.sourceQuote,
      confidence: loop.confidence,
    })),
  });
  const lowConfidence = loopsToPersist.length > 0 && loopsToPersist.every((loop) => loop.confidence < highConfidenceLoopThreshold);
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
      ordinalMap: Object.fromEntries(persistedLoops.map((loop, index) => [index + 1, loop.id])),
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
  ];

  return {
    status: "processed",
    inboundEmailId: email.id,
    intent: extraction.intent,
    loops: persistedLoops,
    privateReply,
    nudgeId: nudge.id,
    events,
  };
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

function chooseInitialLoopStatus(loop: LoopCandidate): LoopStatus {
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
