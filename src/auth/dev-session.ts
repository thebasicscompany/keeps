import { cookies } from "next/headers";
import { z } from "zod";

export const devSessionCookieName = "keeps_dev_session";

const devSessionSchema = z.object({
  email: z.string().email(),
  verifiedAt: z.string().datetime(),
});

export type DevSession = z.infer<typeof devSessionSchema>;

export async function getDevSession(): Promise<DevSession | null> {
  const store = await cookies();
  const value = store.get(devSessionCookieName)?.value;

  if (!value) {
    return null;
  }

  try {
    return devSessionSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

export function encodeDevSession(email: string): string {
  return Buffer.from(
    JSON.stringify({
      email: email.toLowerCase(),
      verifiedAt: new Date().toISOString(),
    }),
  ).toString("base64url");
}
