/**
 * instrumented-generate-object.ts
 *
 * Thin instrumentation wrapper around the Vercel AI SDK `generateObject`.
 *
 * It passes the model/schema/schemaName/system/prompt through VERBATIM (the
 * OpenAI strict structured-output schemas must never be reshaped) and records
 * exactly one `model_calls` row per call: latency, token usage, the structured
 * output, the purpose, and — only when KEEPS_MODEL_LOG_PROMPT_PREVIEW==='1' —
 * the first 200 chars of the prompt. On throw it records a row with an
 * errorMessage and then rethrows.
 *
 * Logging is best-effort: the DB writer swallows missing-DATABASE_URL / DB
 * errors so observability never breaks a model call. Both the underlying
 * `generate` fn and the `writer` are injectable for tests (no live creds, no DB
 * required).
 */

import { generateObject as aiGenerateObject, type GenerateObjectResult } from "ai";
import { getOptionalEnv } from "@/config/env";
import { getDb } from "@/db/client";
import { modelCalls, type NewModelCall } from "@/db/schema";

// ---------------------------------------------------------------------------
// Purpose enum
// ---------------------------------------------------------------------------

export type ModelCallPurpose =
  | "extract_loops"
  | "classify_intent"
  | "draft_nudge"
  | "draft_slack"
  | "draft_calendar"
  | "summarize_report"
  | "summarize_entity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The AI SDK `generateObject` argument object PLUS our instrumentation fields.
 * We deliberately keep the AI SDK args as an opaque passthrough bag so we never
 * reshape the (strict) schema/schemaName/system/prompt the callers built.
 */
export type InstrumentedGenerateObjectArgs = Record<string, unknown> & {
  purpose: ModelCallPurpose;
  userId?: string | null;
  inboundEmailId?: string | null;
};

/** Injectable underlying generate fn. Defaults to the AI SDK's generateObject. */
export type GenerateObjectFn = (args: Record<string, unknown>) => Promise<GenerateObjectResult<unknown>>;

/** Injectable best-effort writer for the model_calls row. */
export type ModelCallWriter = (row: NewModelCall) => Promise<void>;

// ---------------------------------------------------------------------------
// Default DB writer — swallows DB errors / missing DATABASE_URL
// ---------------------------------------------------------------------------

/**
 * Best-effort insert into model_calls. Tolerates an absent DATABASE_URL (getDb
 * throws) and any insert failure: logging must never break the model call.
 * `db` is injectable so tests can pass an in-memory fake; defaults to getDb().
 */
export async function writeModelCall(
  row: NewModelCall,
  db: ReturnType<typeof getDb> | null = getDbSafe(),
): Promise<void> {
  if (!db) {
    return;
  }

  try {
    await db.insert(modelCalls).values(row);
  } catch {
    // Swallow: a logging failure must never propagate to the model call path.
  }
}

/**
 * getDb() throws if DATABASE_URL is unset. We never want that to break the
 * model call, so resolve it lazily and return null on any failure.
 */
function getDbSafe(): ReturnType<typeof getDb> | null {
  try {
    return getDb();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// modelId extraction
// ---------------------------------------------------------------------------

/**
 * A LanguageModel is either a provider model-id string or a model object that
 * exposes `.modelId`. Resolve a stable string either way.
 */
function resolveModelId(model: unknown): string {
  if (typeof model === "string") {
    return model;
  }
  if (model && typeof model === "object" && "modelId" in model) {
    const id = (model as { modelId: unknown }).modelId;
    if (typeof id === "string") {
      return id;
    }
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

export async function instrumentedGenerateObject(
  args: InstrumentedGenerateObjectArgs,
  deps?: {
    generate?: GenerateObjectFn;
    writer?: ModelCallWriter;
  },
): Promise<GenerateObjectResult<unknown>> {
  const generate = deps?.generate ?? (aiGenerateObject as unknown as GenerateObjectFn);
  const writer = deps?.writer ?? writeModelCall;

  // Split our instrumentation fields off; everything else is passed through to
  // the AI SDK UNCHANGED (schema/schemaName/system/prompt/model/etc).
  const { purpose, userId = null, inboundEmailId = null, ...generateArgs } = args;

  const modelId = resolveModelId(generateArgs.model);
  const prompt = generateArgs.prompt;
  const env = getOptionalEnv();
  const promptPreview =
    env.KEEPS_MODEL_LOG_PROMPT_PREVIEW === "1" && typeof prompt === "string"
      ? prompt.slice(0, 200)
      : null;

  const startedAt = Date.now();

  try {
    const result = await generate(generateArgs);
    const latencyMs = Date.now() - startedAt;

    await writer({
      userId: userId ?? null,
      inboundEmailId: inboundEmailId ?? null,
      purpose,
      modelId,
      latencyMs,
      inputTokens: numberOrNull(result.usage?.inputTokens),
      outputTokens: numberOrNull(result.usage?.outputTokens),
      structuredOutput: result.object as NewModelCall["structuredOutput"],
      promptPreview,
      errorMessage: null,
    });

    return result;
  } catch (error) {
    const latencyMs = Date.now() - startedAt;

    await writer({
      userId: userId ?? null,
      inboundEmailId: inboundEmailId ?? null,
      purpose,
      modelId,
      latencyMs,
      inputTokens: null,
      outputTokens: null,
      structuredOutput: null,
      promptPreview,
      errorMessage: error instanceof Error ? error.message : String(error),
    });

    throw error;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
