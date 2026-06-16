/**
 * Caps (Wave C, SR7 attention budget) — pure cap evaluation. The CALLER supplies the
 * recent usage count (the executor computes it inside its FOR UPDATE txn against
 * automation_runs / automation_run_actions), so this stays DB-less and deterministic.
 */
import type { GrantCaps, GrantCapWindow } from "@/automation/types";
import type { KeepsActionKind } from "@/policy/actions";

export type CapStatus = { ok: true } | { ok: false; limit: number; used: number; window: GrantCapWindow };

export function capStatus(input: {
  caps: GrantCaps | undefined;
  actionKind: KeepsActionKind;
  recentCount: number;
}): CapStatus {
  const cap = input.caps?.[input.actionKind];
  if (!cap) return { ok: true };
  if (input.recentCount >= cap.limit) {
    return { ok: false, limit: cap.limit, used: input.recentCount, window: cap.window };
  }
  return { ok: true };
}

/**
 * Start of the cap window relative to `now`. 'day' → start of the current UTC day;
 * 'lifetime' → null (count all-time). The executor uses this to scope its usage query.
 */
export function capWindowStart(window: GrantCapWindow, now: Date): Date | null {
  if (window === "lifetime") return null;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
