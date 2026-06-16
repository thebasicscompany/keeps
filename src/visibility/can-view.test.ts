import { describe, it, expect } from "vitest";
import { canView, selfOnlyScope, type ResourceDescriptor, type ViewerScope } from "@/visibility/can-view";

const ORG = "org-1";

function viewer(over: Partial<ViewerScope> = {}): ViewerScope {
  return { ...selfOnlyScope("viewer", ORG), ...over };
}

function resource(over: Partial<ResourceDescriptor> = {}): ResourceDescriptor {
  return { orgId: ORG, ownerUserId: "someone-else", scopeIds: [], resourceId: "res-1", ...over };
}

describe("canView (the visibility chokepoint)", () => {
  it("sees own resource", () => {
    expect(canView(viewer(), resource({ ownerUserId: "viewer" }))).toBe(true);
  });

  it("default-denies a colleague's resource with no connecting edge", () => {
    expect(canView(viewer(), resource({ ownerUserId: "someone-else" }))).toBe(false);
  });

  it("fails closed across orgs — even an org admin cannot see another org", () => {
    expect(
      canView(viewer({ isOrgAdmin: true }), resource({ orgId: "org-2", ownerUserId: "x" })),
    ).toBe(false);
  });

  it("fails closed when either org is blank", () => {
    expect(canView(viewer({ orgId: "" }), resource())).toBe(false);
    expect(canView(viewer(), resource({ orgId: "" }))).toBe(false);
  });

  it("org admin sees any resource within their org", () => {
    expect(canView(viewer({ isOrgAdmin: true }), resource({ ownerUserId: "anyone" }))).toBe(true);
  });

  it("manager sees a report's resource, not a non-report's", () => {
    const mgr = viewer({ managedUserIds: new Set(["report-a"]) });
    expect(canView(mgr, resource({ ownerUserId: "report-a" }))).toBe(true);
    expect(canView(mgr, resource({ ownerUserId: "report-b" }))).toBe(false);
  });

  it("scope overlap grants visibility; disjoint scopes do not", () => {
    const onAcme = viewer({ scopeIds: new Set(["acme"]) });
    expect(canView(onAcme, resource({ ownerUserId: "x", scopeIds: ["acme"] }))).toBe(true);
    expect(canView(onAcme, resource({ ownerUserId: "x", scopeIds: ["beta"] }))).toBe(false);
    // Multiple memberships overlapping at once (the realistic case).
    const dual = viewer({ scopeIds: new Set(["acme", "beta"]) });
    expect(canView(dual, resource({ ownerUserId: "x", scopeIds: ["beta"] }))).toBe(true);
  });

  it("explicit share grants exactly the shared resource and nothing else", () => {
    const shared = viewer({ sharedResourceIds: new Set(["res-1"]) });
    expect(canView(shared, resource({ ownerUserId: "x", resourceId: "res-1" }))).toBe(true);
    expect(canView(shared, resource({ ownerUserId: "x", resourceId: "res-2" }))).toBe(false);
  });

  it("degenerate solo case: selfOnlyScope sees own, denies others", () => {
    const solo = selfOnlyScope("u", ORG);
    expect(canView(solo, resource({ ownerUserId: "u" }))).toBe(true);
    expect(canView(solo, resource({ ownerUserId: "other" }))).toBe(false);
  });
});
