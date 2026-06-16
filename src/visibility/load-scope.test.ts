import { describe, it, expect } from "vitest";
import { assembleViewerScope, type ScopeEdge } from "@/visibility/load-scope";

const ORG = "org-1";

describe("assembleViewerScope (pure fold)", () => {
  it("member with no edges sees only their own (degenerate solo)", () => {
    const s = assembleViewerScope({ userId: "u", orgId: ORG, role: "member", edges: [] });
    expect(s.isOrgAdmin).toBe(false);
    expect(s.managedUserIds.size).toBe(0);
    expect(s.scopeIds.size).toBe(0);
    expect(s.sharedResourceIds.size).toBe(0);
  });

  it("owner/admin role → isOrgAdmin", () => {
    expect(assembleViewerScope({ userId: "u", orgId: ORG, role: "owner", edges: [] }).isOrgAdmin).toBe(true);
    expect(assembleViewerScope({ userId: "u", orgId: ORG, role: "admin", edges: [] }).isOrgAdmin).toBe(true);
  });

  it("an explicit org_admin edge also grants admin (defense in depth)", () => {
    const edges: ScopeEdge[] = [{ relation: "org_admin", objectType: "org", objectId: ORG }];
    expect(assembleViewerScope({ userId: "u", orgId: ORG, role: "member", edges }).isOrgAdmin).toBe(true);
  });

  it("folds each relation into the right bucket, ignoring mismatched object types", () => {
    const edges: ScopeEdge[] = [
      { relation: "manager_of", objectType: "user", objectId: "report-a" },
      { relation: "manager_of", objectType: "scope", objectId: "BOGUS" }, // wrong object type → ignored
      { relation: "scope_member", objectType: "scope", objectId: "acme" },
      { relation: "explicit_share", objectType: "loop", objectId: "loop-9" },
      { relation: "explicit_share", objectType: "entity", objectId: "ent-3" },
      { relation: "explicit_share", objectType: "org", objectId: "BOGUS" }, // wrong object type → ignored
    ];
    const s = assembleViewerScope({ userId: "u", orgId: ORG, role: "member", edges });
    expect([...s.managedUserIds]).toEqual(["report-a"]);
    expect([...s.scopeIds]).toEqual(["acme"]);
    expect([...s.sharedResourceIds].sort()).toEqual(["ent-3", "loop-9"]);
  });
});
