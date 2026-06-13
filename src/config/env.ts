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
