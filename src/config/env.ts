import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().url().optional(),
  KEEPS_DEV_AUTH_SECRET: z.string().min(24).optional(),
  KEEPS_INBOUND_WEBHOOK_SECRET: z.string().min(12).optional(),
  POSTMARK_SERVER_TOKEN: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5.1"),
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),
  INNGEST_DEV: z.string().optional(),
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
    };
  }

  return result.data;
}
