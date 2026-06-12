/**
 * Builds the approve / cancel deep links that go in the approval email.
 *
 * URL CONTRACT (a parallel agent builds the /approvals/<id> page — match exactly):
 *   approve = `${appUrl}/approvals/<approvalId>?token=<plaintextToken>&action=approve`
 *   cancel  = same with `action=cancel`
 *
 * The plaintext token appears ONLY here, in the link that lands in the user's own
 * inbox. It is never logged, never persisted, never placed in an event payload, an
 * audit row, or nudge metadata (rule 7). The caller is responsible for keeping the
 * returned URLs out of logs.
 *
 * Pure: no I/O, no env reads. `appUrl` is injected (from NEXT_PUBLIC_APP_URL at the
 * call site) so this stays trivially testable and deterministic.
 */
export function buildApprovalLinks(input: {
  approvalId: string;
  token: string;
  appUrl: string;
}): { approveUrl: string; cancelUrl: string } {
  const { approvalId, token, appUrl } = input;

  // Strip a single trailing slash so `${base}/approvals/...` never doubles up.
  const base = appUrl.endsWith("/") ? appUrl.slice(0, -1) : appUrl;

  const path = `${base}/approvals/${encodeURIComponent(approvalId)}`;
  const encodedToken = encodeURIComponent(token);

  return {
    approveUrl: `${path}?token=${encodedToken}&action=approve`,
    cancelUrl: `${path}?token=${encodedToken}&action=cancel`,
  };
}
