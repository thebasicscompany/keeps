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

export type LoopProcessingRepository = {
  findInboundEmailById(inboundEmailId: string): Promise<ProcessableInboundEmail | null>;
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
    metadata: Record<string, unknown>;
  }): Promise<PersistedNudge>;
  listCommandableLoops(input: { userId: string; emailThreadId?: string | null }): Promise<PersistedLoop[]>;
  updateLoopFromCommand(input: {
    loopId: string;
    userId: string;
    status: LoopStatus;
    nextCheckAt?: Date | null;
    commandText: string;
    eventType: "confirmed" | "dismissed" | "snoozed" | "marked_done";
  }): Promise<PersistedLoop>;
};

export type Phase2WorkflowEvent =
  | {
      name: "email.classified";
      data: {
        inboundEmailId: string;
        emailThreadId: string;
        userId: string;
        intent: string;
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
  const nudge = await input.repository.createPrivateReplyNudge({
    userId: email.userId,
    inboundEmailId: email.id,
    subject: replySubject(email.normalized.subject),
    body: privateReply,
    metadata: {
      intent: extraction.intent,
      loopCount: persistedLoops.length,
      lowConfidence: loopsToPersist.length > 0 && loopsToPersist.every((loop) => loop.confidence < highConfidenceLoopThreshold),
    },
  });
  const lowConfidence = loopsToPersist.length > 0 && loopsToPersist.every((loop) => loop.confidence < highConfidenceLoopThreshold);
  const events: Phase2WorkflowEvent[] = [
    {
      name: "email.classified",
      data: {
        inboundEmailId: email.id,
        emailThreadId: email.emailThreadId,
        userId: email.userId,
        intent: extraction.intent,
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
}): Promise<ApplyLoopReplyCommandResult> {
  const command = parseLoopReplyCommand(input.text, { now: input.now });
  const commandableLoops = await input.repository.listCommandableLoops({
    userId: input.userId,
    emailThreadId: input.emailThreadId,
  });

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

  for (const target of targets) {
    updatedLoops.push(
      await input.repository.updateLoopFromCommand({
        loopId: target.id,
        userId: input.userId,
        status: statusForCommand(command),
        nextCheckAt: command.type === "snooze" ? command.remindAt : target.nextCheckAt,
        commandText: command.rawText,
        eventType: eventTypeForCommand(command),
      }),
    );
  }

  const events = updatedLoops.map(
    (loop): Phase2WorkflowEvent => ({
      name: "loop.updated",
      data: {
        loopId: loop.id,
        userId: loop.userId,
        status: loop.status,
        eventType: eventTypeForCommand(command),
      },
    }),
  );

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

function statusForCommand(command: Exclude<LoopReplyCommand, { type: "unknown" | "correction" }>): LoopStatus {
  switch (command.type) {
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

function eventTypeForCommand(
  command: Exclude<LoopReplyCommand, { type: "unknown" | "correction" }>,
): "confirmed" | "dismissed" | "snoozed" | "marked_done" {
  switch (command.type) {
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
