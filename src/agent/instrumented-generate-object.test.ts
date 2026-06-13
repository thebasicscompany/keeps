import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  instrumentedGenerateObject,
  writeModelCall,
  type GenerateObjectFn,
  type ModelCallWriter,
} from "@/agent/instrumented-generate-object";
import type { NewModelCall } from "@/db/schema";

// A fake LanguageModel object: the AI SDK accepts a model-id string OR an object
// exposing `.modelId`. getKeepsLanguageModel returns the object form.
const fakeModel = { modelId: "gpt-test-1", specificationVersion: "v3" };

// STRICT-style schema (all required, nullable for optionality) — passed through
// verbatim and asserted unreshaped.
const schema = z.object({ headline: z.string(), bullets: z.array(z.string()) });

function makeWriter() {
  const rows: NewModelCall[] = [];
  const writer: ModelCallWriter = async (row) => {
    rows.push(row);
  };
  return { rows, writer };
}

function fakeGenerate(
  object: unknown,
  usage?: { inputTokens?: number; outputTokens?: number },
): { fn: GenerateObjectFn; received: Record<string, unknown>[] } {
  const received: Record<string, unknown>[] = [];
  const fn: GenerateObjectFn = async (args) => {
    received.push(args);
    return {
      object,
      usage: usage ?? { inputTokens: 11, outputTokens: 7 },
    } as Awaited<ReturnType<GenerateObjectFn>>;
  };
  return { fn, received };
}

afterEach(() => {
  delete process.env.KEEPS_MODEL_LOG_PROMPT_PREVIEW;
  vi.restoreAllMocks();
});

describe("instrumentedGenerateObject", () => {
  it("records one row with purpose/modelId/structuredOutput/tokens on success", async () => {
    const object = { headline: "hi", bullets: ["a"] };
    const { fn, received } = fakeGenerate(object, { inputTokens: 42, outputTokens: 9 });
    const { rows, writer } = makeWriter();

    const result = await instrumentedGenerateObject(
      {
        purpose: "summarize_report",
        userId: "user-123",
        inboundEmailId: "inbound-456",
        model: fakeModel,
        schema,
        schemaName: "KeepsReportSummary",
        system: "sys",
        prompt: "the prompt",
      },
      { generate: fn, writer },
    );

    expect(result.object).toEqual(object);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.purpose).toBe("summarize_report");
    expect(row.modelId).toBe("gpt-test-1");
    expect(row.structuredOutput).toEqual(object);
    expect(row.inputTokens).toBe(42);
    expect(row.outputTokens).toBe(9);
    expect(row.userId).toBe("user-123");
    expect(row.inboundEmailId).toBe("inbound-456");
    expect(row.errorMessage).toBeNull();
    expect(typeof row.latencyMs).toBe("number");

    // Schema/args passed through UNCHANGED (the strict schema is not reshaped).
    expect(received).toHaveLength(1);
    const args = received[0]!;
    expect(args.schema).toBe(schema);
    expect(args.schemaName).toBe("KeepsReportSummary");
    expect(args.system).toBe("sys");
    expect(args.prompt).toBe("the prompt");
    expect(args.model).toBe(fakeModel);
    // Instrumentation fields must NOT leak into the AI SDK args.
    expect(args.purpose).toBeUndefined();
    expect(args.userId).toBeUndefined();
    expect(args.inboundEmailId).toBeUndefined();
  });

  it("records null tokens when usage is absent", async () => {
    const { fn } = fakeGenerate({ ok: true }, {});
    const { rows, writer } = makeWriter();

    await instrumentedGenerateObject(
      { purpose: "extract_loops", model: fakeModel, schema, prompt: "p" },
      { generate: fn, writer },
    );

    expect(rows[0]!.inputTokens).toBeNull();
    expect(rows[0]!.outputTokens).toBeNull();
  });

  it("leaves promptPreview null by default", async () => {
    const { fn } = fakeGenerate({ ok: true });
    const { rows, writer } = makeWriter();

    await instrumentedGenerateObject(
      { purpose: "classify_intent", model: fakeModel, schema, prompt: "secret prompt body" },
      { generate: fn, writer },
    );

    expect(rows[0]!.promptPreview).toBeNull();
  });

  it("stores first 200 chars of prompt only when KEEPS_MODEL_LOG_PROMPT_PREVIEW='1'", async () => {
    process.env.KEEPS_MODEL_LOG_PROMPT_PREVIEW = "1";
    const longPrompt = "x".repeat(500);
    const { fn } = fakeGenerate({ ok: true });
    const { rows, writer } = makeWriter();

    await instrumentedGenerateObject(
      { purpose: "draft_slack", model: fakeModel, schema, prompt: longPrompt },
      { generate: fn, writer },
    );

    expect(rows[0]!.promptPreview).toBe("x".repeat(200));
    expect(rows[0]!.promptPreview).toHaveLength(200);
  });

  it("records an errorMessage row and rethrows on failure", async () => {
    const boom = new Error("model exploded");
    const fn: GenerateObjectFn = async () => {
      throw boom;
    };
    const { rows, writer } = makeWriter();

    await expect(
      instrumentedGenerateObject(
        { purpose: "extract_loops", model: fakeModel, schema, prompt: "p" },
        { generate: fn, writer },
      ),
    ).rejects.toThrow("model exploded");

    expect(rows).toHaveLength(1);
    expect(rows[0]!.errorMessage).toBe("model exploded");
    expect(rows[0]!.structuredOutput).toBeNull();
    expect(rows[0]!.modelId).toBe("gpt-test-1");
  });

  it("default writeModelCall swallows a DB insert failure (does not throw)", async () => {
    // Fake db whose insert(...).values(...) rejects — mirrors a real DB error or
    // a missing DATABASE_URL. writeModelCall must swallow it, never rethrow.
    const explodingDb = {
      insert: () => ({
        values: async () => {
          throw new Error("connection refused");
        },
      }),
    } as unknown as Parameters<typeof writeModelCall>[1];

    await expect(
      writeModelCall(
        {
          purpose: "extract_loops",
          modelId: "gpt-test-1",
        } as NewModelCall,
        explodingDb,
      ),
    ).resolves.toBeUndefined();
  });

  it("does NOT break the model call when the writer fails (wired with real writeModelCall)", async () => {
    const object = { headline: "ok", bullets: [] };
    const { fn } = fakeGenerate(object);
    const explodingDb = {
      insert: () => ({
        values: async () => {
          throw new Error("DATABASE_URL is required for database access.");
        },
      }),
    } as unknown as Parameters<typeof writeModelCall>[1];

    // Inject the REAL writeModelCall but with a throwing db — its internal
    // swallow keeps the model call working and returning the result.
    const writer: ModelCallWriter = (row) => writeModelCall(row, explodingDb);

    const result = await instrumentedGenerateObject(
      { purpose: "summarize_report", model: fakeModel, schema, prompt: "p" },
      { generate: fn, writer },
    );

    expect(result.object).toEqual(object);
  });
});
