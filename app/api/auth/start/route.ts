import { NextResponse } from "next/server";
import { z } from "zod";
import { devSessionCookieName, encodeDevSession } from "@/auth/dev-session";
import { verifyDevUserAndClaimInbound } from "@/auth/dev-users";
import { getOptionalEnv } from "@/config/env";
import { normalizeIdentityEmail } from "@/email/address";

const startAuthSchema = z.object({
  email: z.string().email(),
});

export async function POST(request: Request) {
  const env = getOptionalEnv();
  const formData = await request.formData();
  const parsed = startAuthSchema.safeParse({
    email: formData.get("email"),
  });

  if (!parsed.success) {
    return NextResponse.redirect(new URL("/?auth_error=invalid_email", request.url), 303);
  }

  const email = normalizeIdentityEmail(parsed.data.email);

  if (env.DATABASE_URL) {
    try {
      await verifyDevUserAndClaimInbound(email);
    } catch {
      return NextResponse.redirect(new URL("/?auth_error=persistence_failed", request.url), 303);
    }
  }

  const response = NextResponse.redirect(new URL("/", request.url), 303);
  response.cookies.set(devSessionCookieName, encodeDevSession(email), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  return response;
}
