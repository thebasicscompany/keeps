import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  connectorCommandDraftSchema,
  connectorActionPayloadSchema,
  connectorDestinationSchema,
  loopCandidateSchema,
  loopExtractionResultSchema,
  type ConnectorCommandDraft,
  type ConnectorActionPayload,
} from "@/agent/schemas";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** "tell Maya I'll send the deck Friday" → slack_dm */
const slackDmDraft: ConnectorCommandDraft = {
  provider: "slack",
  kind: "slack_dm",
  destination: { kind: "person", nameText: "Maya", emailText: null },
  message: "I'll send the deck Friday",
  eventTitle: null,
  whenText: null,
  whenAt: null,
  durationMinutes: null,
  reminderMinutesBefore: null,
  linkedLoopId: null,
  ambiguity: [],
};

/** "@Calendar remind me before the renewal call" → calendar_event */
const calendarEventDraft: ConnectorCommandDraft = {
  provider: "google_calendar",
  kind: "calendar_event",
  destination: { kind: "self", nameText: null, emailText: null },
  message: null,
  eventTitle: "Renewal call",
  whenText: "before the renewal call",
  whenAt: "2026-06-20T14:00:00.000Z",
  durationMinutes: 30,
  reminderMinutesBefore: 10,
  linkedLoopId: null,
  ambiguity: [],
};

const slackDmPayload: ConnectorActionPayload = {
  kind: "slack_dm",
  destination: { kind: "person", nameText: "Maya", emailText: null },
  message: "I'll send the deck Friday",
  channel: "U07MAYA123",
  recipientName: "Maya",
  recipientEmail: "maya@example.com",
};

const calendarEventPayload: ConnectorActionPayload = {
  kind: "calendar_event",
  destination: { kind: "self", nameText: null, emailText: null },
  eventTitle: "Renewal call",
  whenAt: "2026-06-20T14:00:00.000Z",
  durationMinutes: 30,
  reminderMinutesBefore: 10,
  description: "https://keeps.ai/loops/abc-123",
  attendees: null,
};

// ---------------------------------------------------------------------------
// connectorCommandDraftSchema
// ---------------------------------------------------------------------------

describe("connectorCommandDraftSchema", () => {
  it("parses the README slack_dm fixture (tell Maya I'll send the deck Friday)", () => {
    const result = connectorCommandDraftSchema.parse(slackDmDraft);
    expect(result.kind).toBe("slack_dm");
    expect(result.provider).toBe("slack");
    expect(result.destination.kind).toBe("person");
    expect(result.destination.nameText).toBe("Maya");
    expect(result.destination.emailText).toBeNull();
    expect(result.message).toBe("I'll send the deck Friday");
    expect(result.ambiguity).toEqual([]);
  });

  it("parses the README calendar_event fixture (remind me before the renewal call)", () => {
    const result = connectorCommandDraftSchema.parse(calendarEventDraft);
    expect(result.kind).toBe("calendar_event");
    expect(result.provider).toBe("google_calendar");
    expect(result.destination.kind).toBe("self");
    expect(result.eventTitle).toBe("Renewal call");
    expect(result.whenAt).toBe("2026-06-20T14:00:00.000Z");
    expect(result.durationMinutes).toBe(30);
    expect(result.reminderMinutesBefore).toBe(10);
  });

  it("parses a draft with explicit nulls for all nullable fields (strict-mode contract)", () => {
    const allNulls: ConnectorCommandDraft = {
      provider: "slack",
      kind: "slack_dm",
      destination: { kind: "self", nameText: null, emailText: null },
      message: null,
      eventTitle: null,
      whenText: null,
      whenAt: null,
      durationMinutes: null,
      reminderMinutesBefore: null,
      linkedLoopId: null,
      ambiguity: [],
    };
    expect(() => connectorCommandDraftSchema.parse(allNulls)).not.toThrow();
  });

  it("rejects when provider is missing (required field)", () => {
    const { provider: _removed, ...withoutProvider } = slackDmDraft;
    expect(() => connectorCommandDraftSchema.parse(withoutProvider)).toThrow();
  });

  it("rejects when kind is missing (required field)", () => {
    const { kind: _removed, ...withoutKind } = slackDmDraft;
    expect(() => connectorCommandDraftSchema.parse(withoutKind)).toThrow();
  });

  it("rejects when destination is missing (required field)", () => {
    const { destination: _removed, ...withoutDestination } = slackDmDraft;
    expect(() => connectorCommandDraftSchema.parse(withoutDestination)).toThrow();
  });

  it("rejects when ambiguity is missing (required field — not nullable)", () => {
    const { ambiguity: _removed, ...withoutAmbiguity } = slackDmDraft;
    expect(() => connectorCommandDraftSchema.parse(withoutAmbiguity)).toThrow();
  });

  it("rejects null for ambiguity (it is required and non-nullable)", () => {
    expect(() =>
      connectorCommandDraftSchema.parse({ ...slackDmDraft, ambiguity: null }),
    ).toThrow();
  });

  it("rejects when a nullable field is omitted entirely (omission !== null — proves required-not-optional)", () => {
    // message is nullable (z.string().nullable()) but still required — omitting it must fail
    const { message: _removed, ...withoutMessage } = slackDmDraft;
    expect(() => connectorCommandDraftSchema.parse(withoutMessage)).toThrow();
  });

  it("accepts null for a nullable field (explicit null succeeds)", () => {
    expect(() =>
      connectorCommandDraftSchema.parse({ ...slackDmDraft, message: null }),
    ).not.toThrow();
  });

  it("rejects an invalid provider value", () => {
    expect(() =>
      connectorCommandDraftSchema.parse({ ...slackDmDraft, provider: "linear" }),
    ).toThrow();
  });

  it("rejects an invalid kind value", () => {
    expect(() =>
      connectorCommandDraftSchema.parse({ ...slackDmDraft, kind: "email" }),
    ).toThrow();
  });

  it("parses destination with kind='self' and nulls for nameText/emailText", () => {
    const self = connectorDestinationSchema.parse({ kind: "self", nameText: null, emailText: null });
    expect(self.kind).toBe("self");
    expect(self.nameText).toBeNull();
    expect(self.emailText).toBeNull();
  });

  it("parses destination with kind='person' and an email address", () => {
    const person = connectorDestinationSchema.parse({
      kind: "person",
      nameText: "Maya",
      emailText: "maya@example.com",
    });
    expect(person.kind).toBe("person");
    expect(person.nameText).toBe("Maya");
    expect(person.emailText).toBe("maya@example.com");
  });

  it("rejects when destination.kind is missing", () => {
    expect(() =>
      connectorCommandDraftSchema.parse({
        ...slackDmDraft,
        destination: { nameText: "Maya", emailText: null },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// connectorActionPayloadSchema
// ---------------------------------------------------------------------------

describe("connectorActionPayloadSchema", () => {
  it("parses a valid slack_dm payload", () => {
    const result = connectorActionPayloadSchema.parse(slackDmPayload);
    expect(result.kind).toBe("slack_dm");
    if (result.kind === "slack_dm") {
      expect(result.destination.nameText).toBe("Maya");
      expect(result.message).toBe("I'll send the deck Friday");
    }
  });

  it("parses a valid calendar_event payload", () => {
    const result = connectorActionPayloadSchema.parse(calendarEventPayload);
    expect(result.kind).toBe("calendar_event");
    if (result.kind === "calendar_event") {
      expect(result.eventTitle).toBe("Renewal call");
      expect(result.whenAt).toBe("2026-06-20T14:00:00.000Z");
      expect(result.durationMinutes).toBe(30);
      expect(result.reminderMinutesBefore).toBe(10);
      expect(result.description).toBe("https://keeps.ai/loops/abc-123");
    }
  });

  it("parses slack_dm with all nullable fields set to null", () => {
    const nullPayload: ConnectorActionPayload = {
      kind: "slack_dm",
      destination: { kind: "self", nameText: null, emailText: null },
      message: null,
      channel: "U07SELF999",
      recipientName: null,
      recipientEmail: null,
    };
    expect(() => connectorActionPayloadSchema.parse(nullPayload)).not.toThrow();
  });

  it("parses calendar_event with all nullable fields set to null", () => {
    const nullPayload: ConnectorActionPayload = {
      kind: "calendar_event",
      destination: { kind: "self", nameText: null, emailText: null },
      eventTitle: null,
      whenAt: null,
      durationMinutes: null,
      reminderMinutesBefore: null,
      description: null,
      attendees: null,
    };
    expect(() => connectorActionPayloadSchema.parse(nullPayload)).not.toThrow();
  });

  it("rejects when kind is missing", () => {
    const { kind: _removed, ...withoutKind } = slackDmPayload;
    expect(() => connectorActionPayloadSchema.parse(withoutKind)).toThrow();
  });

  it("rejects when kind is an unknown value", () => {
    expect(() =>
      connectorActionPayloadSchema.parse({ ...slackDmPayload, kind: "unknown_action" }),
    ).toThrow();
  });

  it("rejects slack_dm when message is omitted (required-not-optional)", () => {
    const { message: _removed, ...withoutMessage } = slackDmPayload;
    expect(() => connectorActionPayloadSchema.parse(withoutMessage)).toThrow();
  });

  it("rejects calendar_event when whenAt is omitted (required-not-optional)", () => {
    const { whenAt: _removed, ...withoutWhenAt } = calendarEventPayload;
    expect(() => connectorActionPayloadSchema.parse(withoutWhenAt)).toThrow();
  });

  it("accepts null for message on slack_dm (nullable)", () => {
    expect(() =>
      connectorActionPayloadSchema.parse({ ...slackDmPayload, message: null }),
    ).not.toThrow();
  });

  it("accepts null for whenAt on calendar_event (nullable)", () => {
    expect(() =>
      connectorActionPayloadSchema.parse({ ...calendarEventPayload, whenAt: null }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Phase 7 B1 — STRICT-MODE GUARD (§6b R8)
//
// Locks the OpenAI strict structured-output contract for the loop-extraction
// schemas so a future edit can't reintroduce the prod outage (commit 77717a3).
// We convert the schema to JSON Schema (zod 4 built-in z.toJSONSchema) and
// assert the structural invariants:
//   - every object's properties are ALL in `required` (no optional fields)
//   - every object is `additionalProperties: false`
//   - NO `default` anywhere (strict mode rejects defaults)
//   - NO `oneOf`/`allOf` anywhere (discriminatedUnion/composition is rejected)
//   - the ONLY `anyOf` permitted is the nullable encoding `[T, {type:"null"}]`
//     that `.nullable()` produces — that IS how the AI SDK encodes nullables
//     under strict mode and is allowed; any other `anyOf` (a real union) fails.
// ---------------------------------------------------------------------------

/** Walk every object node in a JSON Schema and assert the strict invariants. */
function assertStrictNode(node: unknown, path: string, violations: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => assertStrictNode(child, `${path}[${i}]`, violations));
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  const obj = node as Record<string, unknown>;

  if ("default" in obj) {
    violations.push(`${path}: has 'default' (strict mode forbids defaults)`);
  }
  if ("oneOf" in obj) {
    violations.push(`${path}: has 'oneOf' (composition is rejected by strict mode)`);
  }
  if ("allOf" in obj) {
    violations.push(`${path}: has 'allOf' (composition is rejected by strict mode)`);
  }

  // anyOf is permitted ONLY as the nullable encoding: exactly one non-null
  // branch + one {type:"null"} branch. Anything else is a real union → reject.
  if ("anyOf" in obj) {
    const branches = obj.anyOf as unknown[];
    const nullBranches = branches.filter(
      (b) => b !== null && typeof b === "object" && (b as Record<string, unknown>).type === "null",
    );
    const isNullableEncoding = branches.length === 2 && nullBranches.length === 1;
    if (!isNullableEncoding) {
      violations.push(
        `${path}: has a non-nullable 'anyOf' (${branches.length} branches) — real unions are rejected`,
      );
    }
  }

  // For object nodes: every property must be required + additionalProperties false.
  if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
    const props = obj.properties as Record<string, unknown>;
    const propKeys = Object.keys(props);
    const required = Array.isArray(obj.required) ? (obj.required as string[]) : [];

    for (const key of propKeys) {
      if (!required.includes(key)) {
        violations.push(`${path}: property '${key}' is not in 'required' (must be required-not-optional)`);
      }
    }
    if (obj.additionalProperties !== false) {
      violations.push(`${path}: additionalProperties is not false`);
    }
  }

  // Recurse into all child values.
  for (const [key, value] of Object.entries(obj)) {
    assertStrictNode(value, `${path}.${key}`, violations);
  }
}

describe("loop-extraction strict-mode guard (Phase 7 B1, §6b R8)", () => {
  it("loopCandidateSchema converts to a strict-safe JSON Schema (all required, no default/oneOf/allOf)", () => {
    const json = z.toJSONSchema(loopCandidateSchema);
    const violations: string[] = [];
    assertStrictNode(json, "loopCandidate", violations);
    expect(violations).toEqual([]);
  });

  it("loopExtractionResultSchema converts to a strict-safe JSON Schema", () => {
    const json = z.toJSONSchema(loopExtractionResultSchema);
    const violations: string[] = [];
    assertStrictNode(json, "loopExtractionResult", violations);
    expect(violations).toEqual([]);
  });

  it("loopCandidateSchema includes the B1 reconciliation fields in required", () => {
    const json = z.toJSONSchema(loopCandidateSchema) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    for (const field of [
      "reconcilesLoopRef",
      "reconcileAction",
      "reconcileConfidence",
      "reconcileEvidence",
    ]) {
      expect(json.properties).toHaveProperty(field);
      expect(json.required).toContain(field);
    }
  });

  it("reconcileAction is a plain string enum (create/update/close), not a union", () => {
    const json = z.toJSONSchema(loopCandidateSchema) as {
      properties: Record<string, { type?: string; enum?: string[]; anyOf?: unknown }>;
    };
    const action = json.properties.reconcileAction;
    expect(action.type).toBe("string");
    expect(action.enum).toEqual(["create", "update", "close"]);
    expect(action.anyOf).toBeUndefined();
  });
});
