import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { getOptionalEnv } from "@/config/env";

export function getKeepsLanguageModel(): LanguageModel | null {
  const env = getOptionalEnv();

  if (!env.OPENAI_API_KEY) {
    return null;
  }

  return createOpenAI({
    apiKey: env.OPENAI_API_KEY,
  })(env.OPENAI_MODEL);
}
