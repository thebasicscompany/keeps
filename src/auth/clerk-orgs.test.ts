import { describe, it, expect } from "vitest";
import { mapClerkRole } from "@/auth/clerk-orgs";

describe("mapClerkRole", () => {
  it("maps Clerk role strings to Keeps membership roles", () => {
    expect(mapClerkRole("org:owner")).toBe("owner");
    expect(mapClerkRole("owner")).toBe("owner");
    expect(mapClerkRole("org:admin")).toBe("admin");
    expect(mapClerkRole("admin")).toBe("admin");
    expect(mapClerkRole("org:member")).toBe("member");
    expect(mapClerkRole("member")).toBe("member");
  });

  it("fails safe to the least-privileged role (member) on unknown/empty", () => {
    expect(mapClerkRole(undefined)).toBe("member");
    expect(mapClerkRole(null)).toBe("member");
    expect(mapClerkRole("")).toBe("member");
    expect(mapClerkRole("org:billing_manager")).toBe("member");
  });
});
