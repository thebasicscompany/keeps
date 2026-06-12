import type { LoopStatus } from "@/agent/schemas";

/**
 * Loop urgency is derived at query time from a loop's lifecycle status and its
 * timestamps — it is intentionally NOT a stored `loop_status` value (see AR-6).
 *
 * `due_soon` and `overdue` were removed from the persisted `loop_status` enum in
 * Phase 2.5; this helper reconstructs them on demand. Phase 3 adopts it for
 * digest/query-time rendering.
 */
export type LoopUrgency = "due_soon" | "overdue";

type UrgencyInput = {
  status: LoopStatus;
  dueAt: Date | null;
  nextCheckAt: Date | null;
};

/**
 * Derive a loop's urgency relative to `now`.
 *
 * - `overdue` when the loop has a `dueAt` in the past.
 * - `due_soon` when `nextCheckAt <= now <= dueAt` (the check window has opened
 *   but the due date has not yet passed).
 * - `null` otherwise, including for terminal statuses (`done`, `dismissed`) and
 *   loops with no timing information.
 */
export function deriveUrgency(loop: UrgencyInput, now: Date): LoopUrgency | null {
  // Terminal loops are never urgent.
  if (loop.status === "done" || loop.status === "dismissed") {
    return null;
  }

  const nowMs = now.getTime();

  if (loop.dueAt && loop.dueAt.getTime() < nowMs) {
    return "overdue";
  }

  if (
    loop.nextCheckAt &&
    loop.dueAt &&
    loop.nextCheckAt.getTime() <= nowMs &&
    nowMs <= loop.dueAt.getTime()
  ) {
    return "due_soon";
  }

  return null;
}
