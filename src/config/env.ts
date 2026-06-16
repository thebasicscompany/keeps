import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().url().optional(),
  KEEPS_DEV_AUTH_SECRET: z.string().min(24).optional(),
  KEEPS_INBOUND_WEBHOOK_SECRET: z.string().min(12).optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().optional(),
  POSTMARK_SERVER_TOKEN: z.string().optional(),
  POSTMARK_FROM_ADDRESS: z.string().default("agent@keeps.ai"),
  // Full reply-to base address (local@domain). The nudge mailbox is built by plus-routing
  // the local part: base "abc@inbound.postmarkapp.com" -> "abc+n_<id>@inbound.postmarkapp.com".
  // Parameterized as a full address so the eventual brand domain is a pure env change.
  POSTMARK_REPLY_TO_BASE: z.string().default("agent@keeps.ai"),
  POSTMARK_MESSAGE_STREAM: z.string().default("outbound"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5.1"),
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),
  INNGEST_DEV: z.string().optional(),
  COMPOSIO_API_KEY: z.string().optional(),
  COMPOSIO_WEBHOOK_SECRET: z.string().optional(),
  // Composio auth config nano-IDs (dashboard -> Auth Configs). Live values are in
  // RESEARCH-COMPOSIO.md; set per-environment rather than hard-coded.
  COMPOSIO_SLACK_AUTH_CONFIG_ID: z.string().optional(),
  COMPOSIO_GCAL_AUTH_CONFIG_ID: z.string().optional(),
  // Pinned Composio toolkit versions — REQUIRED for manual tools.execute in
  // @composio/core 0.10.0 ("latest" is rejected at execute time). Override to bump
  // without a code change; defaults live in src/connectors/composio.ts.
  COMPOSIO_SLACK_TOOLKIT_VERSION: z.string().optional(),
  COMPOSIO_GCAL_TOOLKIT_VERSION: z.string().optional(),
  // Phase 6: observability + trust controls. Added up front so parallel Wave A agents
  // (Sentry / model-call logging / Postmark deliverability) only consume these.
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  // "1" enables the 200-char prompt preview on model_calls; off by default (full prompt
  // is never persisted). Requires a manual flip in production env.
  KEEPS_SENTRY_REDACT_EMAILS: z.string().optional(),
  KEEPS_MODEL_LOG_PROMPT_PREVIEW: z.string().optional(),
  // Shared-secret for the Postmark bounce/complaint/delivery webhook (mirrors
  // KEEPS_INBOUND_WEBHOOK_SECRET). Falls back to KEEPS_INBOUND_WEBHOOK_SECRET if unset.
  KEEPS_POSTMARK_WEBHOOK_SECRET: z.string().min(12).optional(),
  // Wave 0/1 (org-visibility re-founding). Default OFF: reads stay legacy per-user scoped.
  // Turning it on requires migration 0021 applied + the personal-org backfill run, else
  // reads filter on a NULL org_id and return nothing. "1"/"true" enables.
  ORG_VISIBILITY_ENABLED: z.string().optional(),
});

export type KeepsEnv = z.infer<typeof envSchema>;

export function getEnv(): KeepsEnv {
  return envSchema.parse(process.env);
}

export function getOptionalEnv(): KeepsEnv {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    return {
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      OPENAI_MODEL: "gpt-5.1",
      POSTMARK_FROM_ADDRESS: "agent@keeps.ai",
      POSTMARK_REPLY_TO_BASE: "agent@keeps.ai",
      POSTMARK_MESSAGE_STREAM: "outbound",
    };
  }

  return result.data;
}

/** Wave 0/1 feature flag: is org-owned hierarchical visibility (canView-scoped reads) live? */
export function isOrgVisibilityEnabled(): boolean {
  const v = getOptionalEnv().ORG_VISIBILITY_ENABLED;
  return v === "1" || v === "true";
}
