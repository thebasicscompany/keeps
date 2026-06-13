import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function mintReportToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashReportToken(token);
  return { token, tokenHash };
}

export function hashReportToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyReportToken(
  token: string,
  { storedHash, expiresAt, now }: { storedHash: string; expiresAt: Date; now: Date },
): boolean {
  if (expiresAt <= now) {
    return false;
  }

  const computedHash = hashReportToken(token);

  // Handle length mismatch without throwing — timingSafeEqual requires equal-length buffers.
  const a = Buffer.from(computedHash, "hex");
  const b = Buffer.from(storedHash, "hex");

  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}
