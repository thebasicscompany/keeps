import { describe, it, expect } from "vitest";
import {
  classifyZone,
  zoneDecisionFor,
  dataWithinConnectingScope,
  type ActionTarget,
} from "@/visibility/zones";
import { selfOnlyScope, type ViewerScope } from "@/visibility/can-view";

const ORG = "org-1";
function viewer(over: Partial<ViewerScope> = {}): ViewerScope {
  return { ...selfOnlyScope("viewer", ORG), ...over };
}

describe("classifyZone", () => {
  it("self → in_scope", () => {
    expect(classifyZone(viewer(), { recipientKind: "self" })).toBe("in_scope");
  });

  it("internal colleague: managed/admin/shared-scope → in_scope; otherwise cross_scope_internal", () => {
    const t: ActionTarget = { recipientKind: "internal", orgId: ORG, userId: "colleague" };
    expect(classifyZone(viewer(), t)).toBe("cross_scope_internal");
    expect(classifyZone(viewer({ isOrgAdmin: true }), t)).toBe("in_scope");
    expect(classifyZone(viewer({ managedUserIds: new Set(["colleague"]) }), t)).toBe("in_scope");
    expect(
      classifyZone(viewer({ scopeIds: new Set(["acme"]) }), {
        recipientKind: "internal",
        orgId: ORG,
        userId: "colleague",
        scopeIds: ["acme"],
      }),
    ).toBe("in_scope");
  });

  it("internal in a DIFFERENT org → external_unscoped (not cross-scope)", () => {
    expect(
      classifyZone(viewer(), { recipientKind: "internal", orgId: "other-org", userId: "x" }),
    ).toBe("external_unscoped");
  });

  it("counterparty sharing a scope → external_counterparty; otherwise external_unscoped", () => {
    const onAcme = viewer({ scopeIds: new Set(["acme"]) });
    expect(classifyZone(onAcme, { recipientKind: "counterparty", orgId: ORG, scopeIds: ["acme"] })).toBe(
      "external_counterparty",
    );
    expect(classifyZone(onAcme, { recipientKind: "counterparty", orgId: ORG, scopeIds: ["beta"] })).toBe(
      "external_unscoped",
    );
  });

  it("unknown external → external_unscoped (fail closed)", () => {
    expect(classifyZone(viewer(), { recipientKind: "external_unknown" })).toBe("external_unscoped");
  });
});

describe("zoneDecisionFor", () => {
  it("private kinds always allowed regardless of zone", () => {
    for (const z of ["in_scope", "cross_scope_internal", "external_unscoped"] as const) {
      expect(zoneDecisionFor("send_private_email_to_user", z)).toBe("allowed");
      expect(zoneDecisionFor("create_private_report", z)).toBe("allowed");
    }
  });

  it("reveal_source denied in every zone", () => {
    expect(zoneDecisionFor("reveal_source", "in_scope")).toBe("denied");
    expect(zoneDecisionFor("reveal_source", "external_counterparty")).toBe("denied");
  });

  it("outward kinds escalate in reachable zones, deny across boundaries", () => {
    expect(zoneDecisionFor("send_slack_message", "in_scope")).toBe("needs_approval");
    expect(zoneDecisionFor("send_email", "external_counterparty")).toBe("needs_approval");
    expect(zoneDecisionFor("send_email", "cross_scope_internal")).toBe("denied");
    expect(zoneDecisionFor("share_loop", "external_unscoped")).toBe("denied");
    expect(zoneDecisionFor("create_calendar_event", "cross_scope_internal")).toBe("denied");
  });
});

describe("dataWithinConnectingScope (leak guard)", () => {
  it("allows data inside a connecting scope, blocks data from another scope", () => {
    const connecting = new Set(["acme"]);
    expect(dataWithinConnectingScope(connecting, [["acme"], ["acme", "other"]])).toBe(true);
    expect(dataWithinConnectingScope(connecting, [["beta"]])).toBe(false);
  });

  it("no connecting scope → only an empty reference set is allowed (fail closed)", () => {
    expect(dataWithinConnectingScope(new Set(), [])).toBe(true);
    expect(dataWithinConnectingScope(new Set(), [["acme"]])).toBe(false);
  });
});
