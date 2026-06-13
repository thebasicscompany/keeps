/**
 * Router driver for the connector e2e fixtures.
 *
 * The fixtures must start at "an email arrives", so they push an inbound email into
 * an in-memory store and call the REAL routeEmail with the REAL deterministic parser
 * (parseConnectorCommand, useModel:false). routeEmail classifies the @Slack/@Calendar
 * email, runs the connector branch, and emits connector.action_requested carrying the
 * parsed ConnectorCommandDraft inline — which the orchestrator then consumes.
 *
 * This is a trimmed copy of the in-memory store from route-email.connector.test.ts
 * (per the task rules: do not modify the existing test file; replicate its fakes).
 */

import type { ConnectorCommandDraft } from "@/agent/schemas";
import { normalizePostmarkInbound, type NormalizedEmail } from "@/email/normalize";
import { directPostmarkFixture } from "@/email/fixtures/postmark";
import type {
  LoopProcessingRepository,
  LoopToPersist,
  PersistedLoop,
  PersistedNudge,
  PrivateReplyNudgeMetadata,
  ProcessableInboundEmail,
} from "@/loops/service";
import type { ReplyTargetStore, ResolvableNudge } from "@/loops/resolve-reply-target";
import { routeEmail, type RouterDeps } from "@/workflows/functions/route-email";
import { parseConnectorCommand } from "@/agent/parse-connector-command";
import type { KeepsWorkflowEvent } from "@/workflows/events";

class InMemoryConnectorStore implements LoopProcessingRepository, ReplyTargetStore {
  readonly emails = new Map<string, ProcessableInboundEmail>();
  readonly nudges = new Map<string, { nudge: PersistedNudge; metadata: PrivateReplyNudgeMetadata }>();
  private nextId = 1;
  timezone: string | null = null;

  addEmail(email: ProcessableInboundEmail) {
    this.emails.set(email.id, email);
  }

  async findInboundEmailById(id: string): Promise<ProcessableInboundEmail | null> {
    return this.emails.get(id) ?? null;
  }
  async findLoopsByInboundEmailId(): Promise<PersistedLoop[]> {
    return [];
  }
  async persistExtractedLoops(_input: {
    email: ProcessableInboundEmail;
    loops: LoopToPersist[];
    normalizedBody: string;
  }): Promise<PersistedLoop[]> {
    return [];
  }
  async createPrivateReplyNudge(input: {
    userId: string;
    inboundEmailId: string;
    subject: string;
    body: string;
    metadata: PrivateReplyNudgeMetadata;
  }): Promise<PersistedNudge> {
    return this.storeNudge(input.userId, input.inboundEmailId, input.body, input.metadata);
  }
  async createReplyNudge(input: {
    userId: string;
    inboundEmailId: string;
    subject: string;
    body: string;
    intent: string;
  }): Promise<PersistedNudge> {
    return this.storeNudge(input.userId, input.inboundEmailId, input.body, {
      kind: "private_reply",
      intent: input.intent,
      loopCount: 0,
      lowConfidence: false,
      ordinalMap: {},
    });
  }
  async listCommandableLoops(): Promise<PersistedLoop[]> {
    return [];
  }
  async updateLoopFromCommand(): Promise<PersistedLoop> {
    throw new Error("not expected in connector e2e tests");
  }
  async recordLoopCorrection(): Promise<void> {}
  async findUserTimezone(): Promise<string | null> {
    return this.timezone;
  }

  async findNudgeById(nudgeId: string): Promise<ResolvableNudge | null> {
    const entry = this.nudges.get(nudgeId);
    return entry ? { id: entry.nudge.id, userId: entry.nudge.userId, metadata: entry.metadata } : null;
  }
  async findNudgeByOutboundInReplyTo(): Promise<ResolvableNudge | null> {
    return null;
  }
  async findLoopsByIds(): Promise<PersistedLoop[]> {
    return [];
  }

  private storeNudge(
    userId: string,
    inboundEmailId: string,
    body: string,
    metadata: PrivateReplyNudgeMetadata,
  ): PersistedNudge {
    const nudge: PersistedNudge = { id: `nudge-${this.nextId++}`, userId, inboundEmailId, body };
    this.nudges.set(nudge.id, { nudge, metadata });
    return nudge;
  }
}

function makeEmail(
  id: string,
  userId: string,
  overrides: Partial<NormalizedEmail>,
): ProcessableInboundEmail {
  return {
    id,
    userId,
    emailThreadId: "thread-1",
    emailMessageId: `message-${id}`,
    normalized: { ...normalizePostmarkInbound(directPostmarkFixture), ...overrides },
  };
}

export interface RoutedCommand {
  command: ConnectorCommandDraft;
  provider: string;
  kind: string;
  inboundEmailId: string;
  userId: string;
  /** Every event the router emitted (so a fixture can assert NO generic side events). */
  events: KeepsWorkflowEvent[];
  /** The nudge id the router sent, if any (connector branch should be null). */
  nudgeId: string | null;
}

/**
 * Drive an inbound @Slack/@Calendar email through the REAL routeEmail with the REAL
 * deterministic parser. Returns the parsed command pulled off connector.action_requested.
 *
 * @param body the raw email body (first line carries the @command).
 * @param now injected clock for the parser's relative-time resolution.
 * @param command optional override: when provided, a deterministic stub parser returns
 *   exactly this command (used by E5 to inject a resolved whenAt, since the offline
 *   regex parser never resolves an absolute timestamp).
 */
export async function routeConnectorEmail(input: {
  body: string;
  userId: string;
  inboundEmailId: string;
  now: Date;
  timezone?: string | null;
  command?: ConnectorCommandDraft;
}): Promise<RoutedCommand> {
  const store = new InMemoryConnectorStore();
  store.timezone = input.timezone ?? null;
  const sent: string[] = [];
  store.addEmail(
    makeEmail(input.inboundEmailId, input.userId, {
      textBody: input.body,
      strippedTextReply: input.body,
    }),
  );

  const parser: RouterDeps["parseConnectorCommand"] = input.command
    ? async () => input.command as ConnectorCommandDraft
    : (parseInput, options) => parseConnectorCommand(parseInput, options);

  const deps: RouterDeps = {
    repository: store,
    replyTargetStore: store,
    sendReply: async (nudgeId: string) => {
      sent.push(nudgeId);
    },
    useModel: false,
    now: input.now,
    parseConnectorCommand: parser,
  };

  const result = await routeEmail(input.inboundEmailId, deps);

  const actionEvent = result.events.find((e) => e.name === "connector.action_requested");
  if (!actionEvent) {
    throw new Error(
      `routeConnectorEmail: expected connector.action_requested but branch was ${result.branch}`,
    );
  }
  const data = actionEvent.data as {
    command: ConnectorCommandDraft;
    provider: string;
    kind: string;
    inboundEmailId: string;
    userId: string;
  };

  return {
    command: data.command,
    provider: data.provider,
    kind: data.kind,
    inboundEmailId: data.inboundEmailId,
    userId: data.userId,
    events: result.events,
    nudgeId: result.nudgeId,
  };
}
