import { describe, expect, it } from "vitest";
import { buildReportEmail, type ReportEmailInput } from "./reply";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LINK = "https://keeps.email/r/tok_abc123";

function makeSection(
  key: string,
  summaries: string[],
): ReportEmailInput["sections"][number] {
  return {
    key,
    title: key,
    rows: summaries.map((s) => ({ loop: { summary: s } })),
  };
}

const BASE_SUMMARY = {
  headline: "You have 5 open loops.",
  bullets: ["Review the proposal", "Follow up with Alex", "Check invoice status"],
};

const BASE_INPUT: ReportEmailInput = {
  kind: "insights",
  scope: {},
  totalOpen: 5,
  sections: [
    makeSection("needs_you", ["Review the proposal", "Follow up with Alex"]),
    makeSection("due_soon", ["Check invoice status"]),
  ],
  link: LINK,
  summary: BASE_SUMMARY,
};

// ---------------------------------------------------------------------------
// Subject tests — all 5 kinds
// ---------------------------------------------------------------------------

describe("buildReportEmail — subject", () => {
  it("insights → 'Your Keeps insights'", () => {
    const { subject } = buildReportEmail({ ...BASE_INPUT, kind: "insights" });
    expect(subject).toBe("Your Keeps insights");
  });

  it("waiting_on → 'What you are waiting on'", () => {
    const { subject } = buildReportEmail({ ...BASE_INPUT, kind: "waiting_on" });
    expect(subject).toBe("What you are waiting on");
  });

  it("stale → 'Stale loops'", () => {
    const { subject } = buildReportEmail({ ...BASE_INPUT, kind: "stale" });
    expect(subject).toBe("Stale loops");
  });

  it("weekly → 'Weekly summary'", () => {
    const { subject } = buildReportEmail({ ...BASE_INPUT, kind: "weekly" });
    expect(subject).toBe("Weekly summary");
  });

  it("entity with scope.entity → 'Loops for <entity>'", () => {
    const { subject } = buildReportEmail({
      ...BASE_INPUT,
      kind: "entity",
      scope: { entity: "Acme Corp" },
    });
    expect(subject).toBe("Loops for Acme Corp");
  });

  it("entity with missing scope.entity falls back to 'Your Keeps insights'", () => {
    const { subject } = buildReportEmail({
      ...BASE_INPUT,
      kind: "entity",
      scope: {},
    });
    expect(subject).toBe("Your Keeps insights");
  });

  it("entity with empty string scope.entity falls back to 'Your Keeps insights'", () => {
    const { subject } = buildReportEmail({
      ...BASE_INPUT,
      kind: "entity",
      scope: { entity: "" },
    });
    expect(subject).toBe("Your Keeps insights");
  });
});

// ---------------------------------------------------------------------------
// Body tests — model summary present
// ---------------------------------------------------------------------------

describe("buildReportEmail — body with model summary", () => {
  it("uses summary.headline as the first line", () => {
    const { textBody } = buildReportEmail(BASE_INPUT);
    const firstLine = textBody.split("\n")[0];
    expect(firstLine).toBe("You have 5 open loops.");
  });

  it("numbers bullets from summary.bullets", () => {
    const { textBody } = buildReportEmail(BASE_INPUT);
    expect(textBody).toContain("1. Review the proposal");
    expect(textBody).toContain("2. Follow up with Alex");
    expect(textBody).toContain("3. Check invoice status");
  });

  it("includes the private view link", () => {
    const { textBody } = buildReportEmail(BASE_INPUT);
    expect(textBody).toContain(`Private view: ${LINK}`);
  });

  it("includes the commandable footer", () => {
    const { textBody } = buildReportEmail(BASE_INPUT);
    expect(textBody).toContain(
      "Reply with done 1, snooze 2 until Monday, dismiss 3 to act on these.",
    );
  });
});

// ---------------------------------------------------------------------------
// Body tests — empty bullets, non-empty rows (fallback to row summaries)
// ---------------------------------------------------------------------------

describe("buildReportEmail — body with empty bullets but non-empty rows", () => {
  const input: ReportEmailInput = {
    ...BASE_INPUT,
    summary: {
      headline: "Here is your report.",
      bullets: [],
    },
    sections: [
      makeSection("needs_you", ["Task A", "Task B"]),
      makeSection("due_soon", ["Task C", "Task D"]),
    ],
  };

  it("falls back to first 3 row summaries across sections", () => {
    const { textBody } = buildReportEmail(input);
    expect(textBody).toContain("1. Task A");
    expect(textBody).toContain("2. Task B");
    expect(textBody).toContain("3. Task C");
    expect(textBody).not.toContain("Task D");
  });

  it("includes footer when rows are present", () => {
    const { textBody } = buildReportEmail(input);
    expect(textBody).toContain(
      "Reply with done 1, snooze 2 until Monday, dismiss 3 to act on these.",
    );
  });

  it("includes 'Most important:' header", () => {
    const { textBody } = buildReportEmail(input);
    expect(textBody).toContain("Most important:");
  });
});

// ---------------------------------------------------------------------------
// Body tests — zero rows and empty bullets
// ---------------------------------------------------------------------------

describe("buildReportEmail — body with zero rows and empty bullets", () => {
  const input: ReportEmailInput = {
    ...BASE_INPUT,
    totalOpen: 0,
    sections: [],
    summary: { headline: "", bullets: [] },
  };

  it("contains 'Nothing needs your attention right now.'", () => {
    const { textBody } = buildReportEmail(input);
    expect(textBody).toContain("Nothing needs your attention right now.");
  });

  it("does NOT include the footer", () => {
    const { textBody } = buildReportEmail(input);
    expect(textBody).not.toContain("Reply with done");
  });

  it("still includes the private view link", () => {
    const { textBody } = buildReportEmail(input);
    expect(textBody).toContain(`Private view: ${LINK}`);
  });

  it("does NOT include 'Most important:'", () => {
    const { textBody } = buildReportEmail(input);
    expect(textBody).not.toContain("Most important:");
  });
});

// ---------------------------------------------------------------------------
// Singular vs plural "loop"/"loops" in deterministic headline fallback
// ---------------------------------------------------------------------------

describe("buildReportEmail — singular/plural headline fallback", () => {
  it("uses 'loop' (singular) when totalOpen is 1 and headline is empty", () => {
    const input: ReportEmailInput = {
      ...BASE_INPUT,
      totalOpen: 1,
      summary: { headline: "", bullets: ["Only task"] },
    };
    const { textBody } = buildReportEmail(input);
    const firstLine = textBody.split("\n")[0];
    expect(firstLine).toBe("You have 1 open loop.");
  });

  it("uses 'loops' (plural) when totalOpen is 2 and headline is empty", () => {
    const input: ReportEmailInput = {
      ...BASE_INPUT,
      totalOpen: 2,
      summary: { headline: "", bullets: ["Task one", "Task two"] },
    };
    const { textBody } = buildReportEmail(input);
    const firstLine = textBody.split("\n")[0];
    expect(firstLine).toBe("You have 2 open loops.");
  });

  it("uses 'loops' (plural) when totalOpen is 0 and headline is empty", () => {
    const input: ReportEmailInput = {
      ...BASE_INPUT,
      totalOpen: 0,
      sections: [],
      summary: { headline: "", bullets: [] },
    };
    const { textBody } = buildReportEmail(input);
    const firstLine = textBody.split("\n")[0];
    expect(firstLine).toBe("You have 0 open loops.");
  });
});

// ---------------------------------------------------------------------------
// Exact shape snapshot — one representative insights email (format locked)
// ---------------------------------------------------------------------------

describe("buildReportEmail — exact shape (insights)", () => {
  it("matches the expected exact string for a standard insights email", () => {
    const input: ReportEmailInput = {
      kind: "insights",
      scope: {},
      totalOpen: 3,
      sections: [
        makeSection("needs_you", ["Draft the contract", "Reply to Sarah"]),
        makeSection("due_soon", ["Submit expense report"]),
      ],
      link: "https://keeps.email/r/tok_xyz789",
      summary: {
        headline: "You have 3 open loops.",
        bullets: ["Draft the contract", "Reply to Sarah", "Submit expense report"],
      },
    };

    const { subject, textBody } = buildReportEmail(input);

    expect(subject).toBe("Your Keeps insights");
    expect(textBody).toBe(
      [
        "You have 3 open loops.",
        "",
        "Most important:",
        "1. Draft the contract",
        "2. Reply to Sarah",
        "3. Submit expense report",
        "",
        "Private view: https://keeps.email/r/tok_xyz789",
        "",
        "Reply with done 1, snooze 2 until Monday, dismiss 3 to act on these.",
      ].join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("buildReportEmail — edge cases", () => {
  it("whitespace-only headline is treated as empty (uses deterministic fallback)", () => {
    const input: ReportEmailInput = {
      ...BASE_INPUT,
      totalOpen: 7,
      summary: { headline: "   ", bullets: ["Task A"] },
    };
    const { textBody } = buildReportEmail(input);
    const firstLine = textBody.split("\n")[0];
    expect(firstLine).toBe("You have 7 open loops.");
  });

  it("bullet fallback caps at 3 even when more rows exist", () => {
    const input: ReportEmailInput = {
      ...BASE_INPUT,
      summary: { headline: "Summary.", bullets: [] },
      sections: [makeSection("needs_you", ["A", "B", "C", "D", "E"])],
    };
    const { textBody } = buildReportEmail(input);
    expect(textBody).toContain("1. A");
    expect(textBody).toContain("2. B");
    expect(textBody).toContain("3. C");
    expect(textBody).not.toContain("4. D");
  });

  it("sections with zero rows are skipped in bullet fallback", () => {
    const input: ReportEmailInput = {
      ...BASE_INPUT,
      summary: { headline: "Summary.", bullets: [] },
      sections: [
        makeSection("needs_you", []),
        makeSection("due_soon", ["X", "Y"]),
      ],
    };
    const { textBody } = buildReportEmail(input);
    expect(textBody).toContain("1. X");
    expect(textBody).toContain("2. Y");
    expect(textBody).not.toContain("3.");
  });
});
