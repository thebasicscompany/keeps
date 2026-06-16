import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { visibleLoopFilter, visibleLoopSql, visibleEntityFilter } from "@/visibility/visible-filter";
import { selfOnlyScope, type ViewerScope } from "@/visibility/can-view";

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const REPORT = "33333333-3333-3333-3333-333333333333";
const SCOPE = "44444444-4444-4444-4444-444444444444";
const SHARED = "55555555-5555-5555-5555-555555555555";

const dialect = new PgDialect();
const render = (q: ReturnType<typeof visibleLoopSql>) => dialect.sqlToQuery(q);

function viewer(over: Partial<ViewerScope> = {}): ViewerScope {
  return { ...selfOnlyScope(USER, ORG), ...over };
}

describe("visibleLoopSql (raw-SQL twin of canView)", () => {
  it("solo admin → org clause + self + literal true", () => {
    const { sql } = render(visibleLoopSql(viewer({ isOrgAdmin: true }), "l"));
    expect(sql).toContain("l.org_id =");
    expect(sql).toContain("l.user_id =");
    expect(sql.toLowerCase()).toContain("or true");
  });

  it("manager → user_id = ANY(report array)", () => {
    const { sql } = render(visibleLoopSql(viewer({ managedUserIds: new Set([REPORT]) }), "l"));
    expect(sql).toContain("l.user_id = ANY(ARRAY[");
    expect(sql).toContain(`'${REPORT}'::uuid`);
  });

  it("scope member → scope_id = ANY; explicit share → id = ANY", () => {
    const s = render(visibleLoopSql(viewer({ scopeIds: new Set([SCOPE]) }), "l")).sql;
    expect(s).toContain("l.scope_id = ANY(ARRAY[");
    expect(s).toContain(`'${SCOPE}'::uuid`);
    const sh = render(visibleLoopSql(viewer({ sharedResourceIds: new Set([SHARED]) }), "l")).sql;
    expect(sh).toContain("l.id = ANY(ARRAY[");
    expect(sh).toContain(`'${SHARED}'::uuid`);
  });

  it("fails closed on a non-uuid orgId / userId (injection guard)", () => {
    expect(() => visibleLoopSql(viewer({ orgId: "'; DROP TABLE loops;--" }), "l")).toThrow();
    expect(() => visibleLoopSql(viewer({ userId: "not-a-uuid" }), "l")).toThrow();
  });

  it("rejects a non-uuid edge id rather than inlining it", () => {
    expect(() => visibleLoopSql(viewer({ scopeIds: new Set(["bad'); DROP"]) }), "l")).toThrow();
  });
});

describe("visibleLoopFilter / visibleEntityFilter (Drizzle twins)", () => {
  it("loop filter scopes by org and includes the self disjunct", () => {
    const { sql } = render(visibleLoopFilter(viewer()));
    expect(sql).toContain('"loops"."org_id"');
    expect(sql).toContain('"loops"."user_id"');
  });

  it("admin loop filter adds a literal true disjunct", () => {
    const { sql } = render(visibleLoopFilter(viewer({ isOrgAdmin: true })));
    expect(sql.toLowerCase()).toContain("or true");
  });

  it("entity filter scopes by org", () => {
    const { sql } = render(visibleEntityFilter(viewer({ scopeIds: new Set([SCOPE]) })));
    expect(sql).toContain('"entities"."org_id"');
    expect(sql).toContain('"entities"."scope_id"');
  });
});
