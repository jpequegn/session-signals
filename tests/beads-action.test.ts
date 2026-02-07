import { describe, it, expect } from "bun:test";
import type { BeadsActionConfig, Pattern, Severity } from "../src/lib/types.js";
import type { BeadsCli } from "../src/actions/beads.js";
import {
  meetsThreshold,
  mapPriority,
  buildIssueTitle,
  findExistingIssue,
  buildUpdateComment,
  buildTrendComment,
  executeBeadsAction,
} from "../src/actions/beads.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makePattern(overrides?: Partial<Pattern>): Pattern {
  return {
    id: "pat-20260205-001",
    type: "recurring_friction",
    scope: "project:/home/user/project",
    description: "Repeated shell failures in tests",
    severity: "medium",
    frequency: 3,
    trend: "stable",
    root_cause_hypothesis: "Missing test dependency",
    suggested_fix: "Install missing dependency",
    auto_fixable: false,
    fix_scope: "project",
    affected_files: ["/src/test.ts"],
    ...overrides,
  };
}

const defaultConfig: BeadsActionConfig = {
  enabled: true,
  min_severity: "medium",
  min_frequency: 2,
  title_prefix: "[signals]",
};

function mockCli(overrides?: Partial<BeadsCli>): BeadsCli {
  return {
    isAvailable: async () => true,
    search: async () => "",
    create: async () => "Created SS-1",
    addComment: async () => "Comment added",
    ...overrides,
  };
}

// ── meetsThreshold ──────────────────────────────────────────────────

describe("meetsThreshold", () => {
  it("returns true when severity and frequency meet threshold", () => {
    expect(meetsThreshold(makePattern({ severity: "medium", frequency: 3 }), defaultConfig)).toBe(true);
  });

  it("returns true when severity exceeds threshold", () => {
    expect(meetsThreshold(makePattern({ severity: "high", frequency: 2 }), defaultConfig)).toBe(true);
  });

  it("returns false when severity is below threshold", () => {
    expect(meetsThreshold(makePattern({ severity: "low", frequency: 5 }), defaultConfig)).toBe(false);
  });

  it("returns false when frequency is below threshold", () => {
    expect(meetsThreshold(makePattern({ severity: "high", frequency: 1 }), defaultConfig)).toBe(false);
  });

  it("handles exact threshold values", () => {
    expect(meetsThreshold(makePattern({ severity: "medium", frequency: 2 }), defaultConfig)).toBe(true);
  });
});

// ── mapPriority ─────────────────────────────────────────────────────

describe("mapPriority", () => {
  it("maps high to 1", () => {
    expect(mapPriority("high")).toBe(1);
  });

  it("maps medium to 2", () => {
    expect(mapPriority("medium")).toBe(2);
  });

  it("maps low to 3", () => {
    expect(mapPriority("low")).toBe(3);
  });
});

// ── buildIssueTitle ─────────────────────────────────────────────────

describe("buildIssueTitle", () => {
  it("prefixes description with config prefix", () => {
    const title = buildIssueTitle(makePattern({ description: "Tool failures" }), "[signals]");
    expect(title).toBe("[signals] Tool failures");
  });

  it("uses custom prefix", () => {
    const title = buildIssueTitle(makePattern({ description: "Bug" }), "[custom]");
    expect(title).toBe("[custom] Bug");
  });

  it("handles empty prefix", () => {
    const title = buildIssueTitle(makePattern({ description: "Bug" }), "");
    expect(title).toBe("Bug");
  });
});

// ── findExistingIssue ───────────────────────────────────────────────

describe("findExistingIssue", () => {
  it("returns null for empty search output", () => {
    expect(findExistingIssue("", "[signals] Shell failures")).toBeNull();
  });

  it("returns null when no matching issues", () => {
    const output = "SS-1  [signals] Some unrelated issue\nSS-2  Another issue";
    expect(findExistingIssue(output, "[signals] Shell failures")).toBeNull();
  });

  it("finds issue with matching full title", () => {
    const output = "SS-1  [signals] Repeated shell failures\nSS-2  Other issue";
    expect(findExistingIssue(output, "[signals] Repeated shell failures")).toBe("SS-1");
  });

  it("returns first matching issue", () => {
    const output = "SS-3  [signals] First match\nSS-5  [signals] First match";
    expect(findExistingIssue(output, "[signals] First match")).toBe("SS-3");
  });

  it("handles lowercase issue IDs", () => {
    const output = "proj-42  [signals] Some pattern";
    expect(findExistingIssue(output, "[signals] Some pattern")).toBe("proj-42");
  });

  it("skips closed issues", () => {
    const output = "SS-1  closed  [signals] Shell failures\nSS-2  [signals] Shell failures";
    expect(findExistingIssue(output, "[signals] Shell failures")).toBe("SS-2");
  });

  it("returns null when all matching issues are closed", () => {
    const output = "SS-1  closed  [signals] Shell failures";
    expect(findExistingIssue(output, "[signals] Shell failures")).toBeNull();
  });

  it("rejects substring matches (exact title only)", () => {
    const output = "SS-1  [signals] Shell failures in CI pipeline";
    expect(findExistingIssue(output, "[signals] Shell failures")).toBeNull();
  });
});

// ── buildUpdateComment / buildTrendComment ──────────────────────────

describe("buildUpdateComment", () => {
  it("includes severity and frequency", () => {
    const comment = buildUpdateComment(makePattern({ severity: "high", frequency: 5 }));
    expect(comment).toContain("high");
    expect(comment).toContain("5 sessions");
  });

  it("includes root cause and suggested fix", () => {
    const comment = buildUpdateComment(makePattern());
    expect(comment).toContain("Missing test dependency");
    expect(comment).toContain("Install missing dependency");
  });

  it("omits root cause and suggested fix when empty", () => {
    const comment = buildUpdateComment(makePattern({ root_cause_hypothesis: "", suggested_fix: "" }));
    expect(comment).not.toContain("Root cause hypothesis");
    expect(comment).not.toContain("Suggested fix");
  });
});

describe("buildTrendComment", () => {
  it("notes improvement when trend is decreasing", () => {
    const comment = buildTrendComment(makePattern({ trend: "decreasing" }));
    expect(comment).toContain("improving");
    expect(comment).toContain("decreasing");
  });

  it("returns standard update for non-decreasing trends", () => {
    const comment = buildTrendComment(makePattern({ trend: "stable" }));
    expect(comment).toContain("Signal update");
    expect(comment).toContain("stable");
  });
});

// ── executeBeadsAction ──────────────────────────────────────────────

describe("executeBeadsAction", () => {
  it("returns empty for empty patterns array", async () => {
    const results = await executeBeadsAction([], defaultConfig, { cli: mockCli() });
    expect(results).toEqual([]);
  });

  it("returns empty when config is disabled", async () => {
    const results = await executeBeadsAction(
      [makePattern()],
      { ...defaultConfig, enabled: false },
    );
    expect(results).toEqual([]);
  });

  it("skips all patterns when bd CLI is unavailable", async () => {
    const cli = mockCli({ isAvailable: async () => false });
    const warnings: string[] = [];

    const results = await executeBeadsAction(
      [makePattern(), makePattern({ id: "pat-2" })],
      defaultConfig,
      { cli, warn: (msg) => warnings.push(msg) },
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.action === "skipped")).toBe(true);
    expect(warnings.some((w) => w.includes("not available"))).toBe(true);
  });

  it("skips patterns below threshold", async () => {
    const cli = mockCli();

    const results = await executeBeadsAction(
      [makePattern({ severity: "low", frequency: 1 })],
      defaultConfig,
      { cli },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("skipped");
    expect(results[0]!.reason).toContain("Below threshold");
  });

  it("creates new issue when no existing match", async () => {
    let createdTitle = "";
    let createdPriority = 0;

    const cli = mockCli({
      search: async () => "",
      create: async (title, _type, priority) => {
        createdTitle = title;
        createdPriority = priority;
        return "Created";
      },
    });

    const results = await executeBeadsAction(
      [makePattern({ severity: "high", frequency: 3 })],
      defaultConfig,
      { cli },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("created");
    expect(createdTitle).toContain("[signals]");
    expect(createdPriority).toBe(1); // high → 1
  });

  it("updates existing issue when match found", async () => {
    let commentedId = "";
    let commentText = "";
    let searchedQuery = "";

    const cli = mockCli({
      search: async (query) => {
        searchedQuery = query;
        return "SS-42  [signals] Repeated shell failures in tests";
      },
      addComment: async (id, comment) => {
        commentedId = id;
        commentText = comment;
        return "Comment added";
      },
    });

    const results = await executeBeadsAction(
      [makePattern()],
      defaultConfig,
      { cli },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("updated");
    expect(commentedId).toBe("SS-42");
    expect(commentText).toContain("Signal update");
    expect(searchedQuery).toBe("Repeated shell failures in tests");
  });

  it("handles CLI errors gracefully", async () => {
    const cli = mockCli({
      search: async () => { throw new Error("CLI crashed"); },
    });
    const warnings: string[] = [];

    const results = await executeBeadsAction(
      [makePattern()],
      defaultConfig,
      { cli, warn: (msg) => warnings.push(msg) },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("skipped");
    expect(results[0]!.reason).toContain("Error");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("processes multiple patterns", async () => {
    const created: string[] = [];
    const cli = mockCli({
      search: async () => "",
      create: async (title) => { created.push(title); return "ok"; },
    });

    const patterns = [
      makePattern({ id: "p1", description: "Pattern one", severity: "high", frequency: 3 }),
      makePattern({ id: "p2", description: "Pattern two", severity: "medium", frequency: 2 }),
      makePattern({ id: "p3", description: "Skipped", severity: "low", frequency: 1 }),
    ];

    const results = await executeBeadsAction(patterns, defaultConfig, { cli });

    expect(results).toHaveLength(3);
    expect(results[0]!.action).toBe("created");
    expect(results[1]!.action).toBe("created");
    expect(results[2]!.action).toBe("skipped");
    expect(created).toHaveLength(2);
  });

  it("adds trend comment for decreasing patterns", async () => {
    let commentText = "";
    const cli = mockCli({
      search: async () => "SS-10  [signals] Repeated shell failures in tests",
      addComment: async (_id, comment) => { commentText = comment; return "ok"; },
    });

    const results = await executeBeadsAction(
      [makePattern({ trend: "decreasing" })],
      defaultConfig,
      { cli },
    );

    expect(results[0]!.action).toBe("updated");
    expect(commentText).toContain("improving");
  });
});
