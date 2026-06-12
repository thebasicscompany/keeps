import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "@/config/env";
import * as schema from "@/db/schema";

let client: ReturnType<typeof postgres> | undefined;

export function getDb() {
  const env = getEnv();

  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for database access.");
  }

  client ??= postgres(env.DATABASE_URL, {
    prepare: false,
  });

  return drizzle(client, { schema });
}
