import type { ActionHandler } from "@/approvals/actions/registry";

/**
 * Phase 3 no-op action handler. It exists so the execute funnel and the action registry can
 * be exercised end-to-end before any real connector (Slack, Calendar) lands in Phase 4. It
 * is also the canonical plug-in shape reference: a real handler does its side effect inside
 * `step.run`-equivalent code and returns `{ ok: true, detail? }`.
 *
 * `test_action` is deliberately NOT a `KeepsActionKind` and is NOT a private action, so the
 * policy gate treats it as EXTERNAL — it only reaches this handler after a valid approved
 * approval has authorized it through `authorize()`.
 */
export const testActionHandler: ActionHandler = async () => {
  return { ok: true };
};
