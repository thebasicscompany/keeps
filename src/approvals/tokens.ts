import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function mintApprovalToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  const hash = hashApprovalToken(token);
  return { token, hash };
}

export function hashApprovalToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyApprovalToken(
  token: string,
  { storedHash, expiresAt, now }: { storedHash: string; expiresAt: Date; now: Date },
): boolean {
  if (expiresAt <= now) {
    return false;
  }

  const computedHash = hashApprovalToken(token);

  // Handle length mismatch without throwing — timingSafeEqual requires equal-length buffers.
  const a = Buffer.from(computedHash, "hex");
  const b = Buffer.from(storedHash, "hex");

  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}
