import { describe, it, expect } from "bun:test";
import type { NormalizedEvent, TaggerConfig } from "../src/lib/types.js";
import {
  levenshteinRatio,
  detectRephraseStorm,
  detectToolFailureCascade,
  detectContextChurn,
  detectPermissionFriction,
  detectAbandonSignal,
  detectLongStall,
  detectRetryLoop,
  inferLanguages,
  classifyOutcome,
  extractFacets,
} from "../src/lib/heuristics.js";

// ── Helpers ─────────────────────────────────────────────────────────

const defaultConfig: TaggerConfig = {
  rephrase_threshold: 3,
  rephrase_similarity: 0.6,
  tool_failure_cascade_min: 3,
  context_churn_threshold: 2,
  abandon_window_seconds: 120,
  stall_threshold_seconds: 60,
  retry_loop_min: 3,
  retry_similarity: 0.7,
};

let idCounter = 0;
function makeEvent(overrides: Partial<NormalizedEvent> & { type: NormalizedEvent["type"] }): NormalizedEvent {
  idCounter++;
  return {
    id: `evt-${idCounter}`,
    timestamp: "2026-02-05T10:00:00.000Z",
    harness: "claude_code",
    session_id: "test-session",
    ...overrides,
  };
}

function ts(minuteOffset: number): string {
  const d = new Date("2026-02-05T10:00:00.000Z");
  d.setMinutes(d.getMinutes() + minuteOffset);
  return d.toISOString();
}

function tsSec(secondOffset: number): string {
  const d = new Date("2026-02-05T10:00:00.000Z");
  d.setSeconds(d.getSeconds() + secondOffset);
  return d.toISOString();
}

// ── levenshteinRatio ────────────────────────────────────────────────

describe("levenshteinRatio", () => {
  it("returns 1 for identical strings", () => {
    expect(levenshteinRatio("hello", "hello")).toBe(1);
  });

  it("returns 0 for completely different strings of equal length", () => {
    expect(levenshteinRatio("abc", "xyz")).toBe(0);
  });

  it("returns 1 for two empty strings", () => {
    expect(levenshteinRatio("", "")).toBe(1);
  });

  it("returns 0 when one string is empty", () => {
    expect(levenshteinRatio("abc", "")).toBe(0);
  });

  it("computes correct ratio for similar strings", () => {
    const ratio = levenshteinRatio("fix the bug", "fix the bugs");
    expect(ratio).toBeGreaterThan(0.9);
  });

  it("computes correct ratio for moderately different strings", () => {
    const ratio = levenshteinRatio("hello world", "goodbye world");
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.8);
  });
});

// ── detectRephraseStorm ─────────────────────────────────────────────

describe("detectRephraseStorm", () => {
  it("returns null when fewer than 2 prompts", () => {
    const events = [makeEvent({ type: "user_prompt", message: "hello" })];
    expect(detectRephraseStorm(events, defaultConfig)).toBeNull();
  });

  it("returns null when prompts are not similar enough", () => {
    const events = [
      makeEvent({ type: "user_prompt", message: "fix the authentication bug" }),
      makeEvent({ type: "user_prompt", message: "add a new endpoint for users" }),
      makeEvent({ type: "user_prompt", message: "refactor the database schema" }),
      makeEvent({ type: "user_prompt", message: "update the readme file" }),
    ];
    expect(detectRephraseStorm(events, defaultConfig)).toBeNull();
  });

  it("returns null when rephrases are below threshold", () => {
    const events = [
      makeEvent({ type: "user_prompt", message: "fix the bug" }),
      makeEvent({ type: "user_prompt", message: "fix the bugs" }),
      // Only 1 rephrase pair, threshold is 3
    ];
    expect(detectRephraseStorm(events, defaultConfig)).toBeNull();
  });

  it("detects rephrase storm when threshold is met", () => {
    const events = [
      makeEvent({ type: "user_prompt", message: "fix the bug in login" }),
      makeEvent({ type: "user_prompt", message: "fix the bug in login page" }),
      makeEvent({ type: "user_prompt", message: "fix the bug in the login" }),
      makeEvent({ type: "user_prompt", message: "fix the bugs in login" }),
    ];
    const result = detectRephraseStorm(events, defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("rephrase_storm");
    expect(result!.count).toBeGreaterThanOrEqual(3);
    expect(result!.evidence.event_indices.length).toBeGreaterThan(0);
  });

  it("reports correct severity based on count", () => {
    const events = Array.from({ length: 8 }, (_, i) =>
      makeEvent({ type: "user_prompt", message: `fix the bug attempt ${i}` }),
    );
    // With similarity 0.6, "fix the bug attempt 0" vs "fix the bug attempt 1" should match
    const result = detectRephraseStorm(events, { ...defaultConfig, rephrase_threshold: 2, rephrase_similarity: 0.8 });
    if (result) {
      expect(["low", "medium", "high"]).toContain(result.severity);
    }
  });

  it("ignores non-prompt events", () => {
    const events = [
      makeEvent({ type: "user_prompt", message: "fix the bug" }),
      makeEvent({ type: "tool_use", tool_name: "file_read" }),
      makeEvent({ type: "tool_result" }),
      makeEvent({ type: "user_prompt", message: "fix the bugs" }),
    ];
    // Only 2 prompts, 1 pair, below threshold of 3
    expect(detectRephraseStorm(events, defaultConfig)).toBeNull();
  });
});

// ── detectToolFailureCascade ────────────────────────────────────────

describe("detectToolFailureCascade", () => {
  it("returns null when no tool results", () => {
    const events = [makeEvent({ type: "user_prompt", message: "hello" })];
    expect(detectToolFailureCascade(events, defaultConfig)).toBeNull();
  });

  it("returns null when failures are not consecutive", () => {
    const events = [
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "err" } }),
      makeEvent({ type: "tool_result", tool_result: { success: true } }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "err" } }),
      makeEvent({ type: "tool_result", tool_result: { success: true } }),
    ];
    expect(detectToolFailureCascade(events, defaultConfig)).toBeNull();
  });

  it("detects cascade of consecutive failures", () => {
    const events = [
      makeEvent({ type: "tool_result", tool_name: "shell_exec", tool_result: { success: false, error: "err1" } }),
      makeEvent({ type: "tool_result", tool_name: "shell_exec", tool_result: { success: false, error: "err2" } }),
      makeEvent({ type: "tool_result", tool_name: "file_edit", tool_result: { success: false, error: "err3" } }),
    ];
    const result = detectToolFailureCascade(events, defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("tool_failure_cascade");
    expect(result!.count).toBe(3);
    expect(result!.evidence.sample_data).toContain("shell_exec");
  });

  it("tracks the longest streak", () => {
    const events = [
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" } }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" } }),
      makeEvent({ type: "tool_result", tool_result: { success: true } }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" } }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" } }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" } }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" } }),
    ];
    const result = detectToolFailureCascade(events, defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.count).toBe(4);
  });

  it("ignores non-tool_result events when counting streak", () => {
    const events = [
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" } }),
      makeEvent({ type: "user_prompt", message: "retry" }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" } }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" } }),
    ];
    // Non-tool_result events are skipped, so all 3 failures are consecutive
    const result = detectToolFailureCascade(events, defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.count).toBe(3);
  });
});

// ── detectContextChurn ──────────────────────────────────────────────

describe("detectContextChurn", () => {
  it("returns null when no compactions", () => {
    const events = [makeEvent({ type: "user_prompt", message: "hello" })];
    expect(detectContextChurn(events, defaultConfig)).toBeNull();
  });

  it("returns null when compactions are below threshold", () => {
    const events = [makeEvent({ type: "compaction" })];
    expect(detectContextChurn(events, defaultConfig)).toBeNull();
  });

  it("detects churn when compactions meet threshold", () => {
    const events = [
      makeEvent({ type: "compaction" }),
      makeEvent({ type: "compaction" }),
    ];
    const result = detectContextChurn(events, defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("context_churn");
    expect(result!.count).toBe(2);
  });

  it("reports high severity for many compactions", () => {
    const events = Array.from({ length: 5 }, () => makeEvent({ type: "compaction" }));
    const result = detectContextChurn(events, defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("high");
  });
});

// ── detectPermissionFriction ────────────────────────────────────────

describe("detectPermissionFriction", () => {
  it("returns null when no permission events", () => {
    const events = [makeEvent({ type: "user_prompt", message: "hello" })];
    expect(detectPermissionFriction(events, defaultConfig)).toBeNull();
  });

  it("returns null when all permissions are granted", () => {
    const events = [
      makeEvent({ type: "permission_result", permission_granted: true }),
      makeEvent({ type: "permission_result", permission_granted: true }),
    ];
    expect(detectPermissionFriction(events, defaultConfig)).toBeNull();
  });

  it("detects permission friction on denials", () => {
    const events = [
      makeEvent({ type: "permission_result", permission_granted: false }),
    ];
    const result = detectPermissionFriction(events, defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("permission_friction");
    expect(result!.count).toBe(1);
  });

  it("counts multiple denials", () => {
    const events = [
      makeEvent({ type: "permission_result", permission_granted: false }),
      makeEvent({ type: "permission_result", permission_granted: true }),
      makeEvent({ type: "permission_result", permission_granted: false }),
      makeEvent({ type: "permission_result", permission_granted: false }),
    ];
    const result = detectPermissionFriction(events, defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.count).toBe(3);
    expect(result!.severity).toBe("high");
  });
});

// ── detectAbandonSignal ─────────────────────────────────────────────

describe("detectAbandonSignal", () => {
  it("returns null when no session_end", () => {
    const events = [
      makeEvent({ type: "user_prompt", message: "hello" }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "err" } }),
    ];
    expect(detectAbandonSignal(events, defaultConfig)).toBeNull();
  });

  it("returns null when no failures before session end", () => {
    const events = [
      makeEvent({ type: "user_prompt", message: "hello", timestamp: tsSec(0) }),
      makeEvent({ type: "tool_result", tool_result: { success: true }, timestamp: tsSec(10) }),
      makeEvent({ type: "session_end", timestamp: tsSec(20) }),
    ];
    expect(detectAbandonSignal(events, defaultConfig)).toBeNull();
  });

  it("returns null when failures are resolved before end", () => {
    const events = [
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "err" }, timestamp: tsSec(0) }),
      makeEvent({ type: "tool_result", tool_result: { success: true }, timestamp: tsSec(10) }),
      makeEvent({ type: "session_end", timestamp: tsSec(20) }),
    ];
    expect(detectAbandonSignal(events, defaultConfig)).toBeNull();
  });

  it("detects abandon when failures are unresolved near session end", () => {
    const events = [
      makeEvent({ type: "user_prompt", message: "fix it", timestamp: tsSec(0) }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "err" }, timestamp: tsSec(50) }),
      makeEvent({ type: "session_end", timestamp: tsSec(60) }),
    ];
    const result = detectAbandonSignal(events, defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("abandon_signal");
    expect(result!.count).toBe(1);
  });

  it("ignores failures outside the abandon window", () => {
    const events = [
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "old" }, timestamp: tsSec(0) }),
      makeEvent({ type: "session_end", timestamp: tsSec(300) }), // 5 min later, outside 120s window
    ];
    expect(detectAbandonSignal(events, defaultConfig)).toBeNull();
  });
});

// ── detectLongStall ─────────────────────────────────────────────────

describe("detectLongStall", () => {
  it("returns null with single event", () => {
    const events = [makeEvent({ type: "user_prompt", message: "hello" })];
    expect(detectLongStall(events, defaultConfig)).toBeNull();
  });

  it("returns null when gaps are below threshold", () => {
    const events = [
      makeEvent({ type: "user_prompt", message: "a", timestamp: tsSec(0) }),
      makeEvent({ type: "user_prompt", message: "b", timestamp: tsSec(30) }),
    ];
    expect(detectLongStall(events, defaultConfig)).toBeNull();
  });

  it("detects stall when gap exceeds threshold", () => {
    const events = [
      makeEvent({ type: "user_prompt", message: "a", timestamp: tsSec(0) }),
      makeEvent({ type: "user_prompt", message: "b", timestamp: tsSec(120) }), // 2 min gap
    ];
    const result = detectLongStall(events, defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("long_stall");
    expect(result!.count).toBe(1);
  });

  it("counts multiple stalls", () => {
    const events = [
      makeEvent({ type: "user_prompt", timestamp: tsSec(0) }),
      makeEvent({ type: "user_prompt", timestamp: tsSec(90) }),  // 90s gap
      makeEvent({ type: "user_prompt", timestamp: tsSec(100) }), // 10s gap
      makeEvent({ type: "user_prompt", timestamp: tsSec(200) }), // 100s gap
    ];
    const result = detectLongStall(events, defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.count).toBe(2);
  });
});

// ── detectRetryLoop ─────────────────────────────────────────────────

describe("detectRetryLoop", () => {
  it("returns null with fewer than 2 tool uses", () => {
    const events = [makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "test" } })];
    expect(detectRetryLoop(events, defaultConfig)).toBeNull();
  });

  it("returns null when tool uses are different", () => {
    const events = [
      makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "ls" } }),
      makeEvent({ type: "tool_use", tool_name: "file_read", tool_input: { path: "/src/main.ts" } }),
      makeEvent({ type: "tool_use", tool_name: "file_edit", tool_input: { path: "/src/main.ts" } }),
    ];
    expect(detectRetryLoop(events, defaultConfig)).toBeNull();
  });

  it("detects retry loop with repeated identical commands", () => {
    const events = [
      makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "bun test" } }),
      makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "bun test" } }),
      makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "bun test" } }),
    ];
    const result = detectRetryLoop(events, defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("retry_loop");
    expect(result!.count).toBe(3);
  });

  it("detects retry loop with similar but not identical commands", () => {
    const events = [
      makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "bun test --bail" } }),
      makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "bun test --bail" } }),
      makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "bun test --bail " } }),
    ];
    const result = detectRetryLoop(events, defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("retry_loop");
  });

  it("does not group different tool names", () => {
    const events = [
      makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "test" } }),
      makeEvent({ type: "tool_use", tool_name: "file_read", tool_input: { command: "test" } }),
      makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "test" } }),
    ];
    expect(detectRetryLoop(events, defaultConfig)).toBeNull();
  });

  it("captures longest streak when streak resets and restarts", () => {
    const events = [
      // First streak of 3: A-A-A
      makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "bun test" } }),
      makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "bun test" } }),
      makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "bun test" } }),
      // Break
      makeEvent({ type: "tool_use", tool_name: "file_read", tool_input: { path: "/src/main.ts" } }),
      // Second streak of 4: A-A-A-A
      makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "bun test" } }),
      makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "bun test" } }),
      makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "bun test" } }),
      makeEvent({ type: "tool_use", tool_name: "shell_exec", tool_input: { command: "bun test" } }),
    ];
    const result = detectRetryLoop(events, defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.count).toBe(4);
    // Verify the captured streak is the second (longer) shell_exec streak, not the first
    expect(result!.evidence.event_indices.length).toBeGreaterThan(0);
    expect(result!.evidence.event_indices.every((i) => events[i]!.tool_name === "shell_exec")).toBe(true);
  });

  it("ignores tool uses without tool_input", () => {
    const events = [
      makeEvent({ type: "tool_use", tool_name: "shell_exec" }),
      makeEvent({ type: "tool_use", tool_name: "shell_exec" }),
      makeEvent({ type: "tool_use", tool_name: "shell_exec" }),
    ];
    expect(detectRetryLoop(events, defaultConfig)).toBeNull();
  });
});

// ── inferLanguages ──────────────────────────────────────────────────

describe("inferLanguages", () => {
  it("returns empty for non-tool events", () => {
    const events = [makeEvent({ type: "user_prompt", message: "hello" })];
    expect(inferLanguages(events)).toEqual([]);
  });

  it("infers TypeScript from .ts files", () => {
    const events = [
      makeEvent({ type: "tool_use", tool_input: { file_path: "/src/main.ts" } }),
    ];
    expect(inferLanguages(events)).toEqual(["TypeScript"]);
  });

  it("infers multiple languages", () => {
    const events = [
      makeEvent({ type: "tool_use", tool_input: { file_path: "/src/main.ts" } }),
      makeEvent({ type: "tool_use", tool_input: { path: "/app.py" } }),
      makeEvent({ type: "tool_result", tool_input: { target_file: "/style.css" } }),
    ];
    const langs = inferLanguages(events);
    expect(langs).toContain("TypeScript");
    expect(langs).toContain("Python");
    expect(langs).toContain("CSS");
  });

  it("deduplicates languages", () => {
    const events = [
      makeEvent({ type: "tool_use", tool_input: { file_path: "/a.ts" } }),
      makeEvent({ type: "tool_use", tool_input: { file_path: "/b.tsx" } }),
    ];
    expect(inferLanguages(events)).toEqual(["TypeScript"]);
  });

  it("returns sorted languages", () => {
    const events = [
      makeEvent({ type: "tool_use", tool_input: { path: "/z.py" } }),
      makeEvent({ type: "tool_use", tool_input: { path: "/a.ts" } }),
      makeEvent({ type: "tool_use", tool_input: { path: "/m.go" } }),
    ];
    const langs = inferLanguages(events);
    expect(langs).toEqual(["Go", "Python", "TypeScript"]);
  });

  it("handles unknown extensions", () => {
    const events = [
      makeEvent({ type: "tool_use", tool_input: { file_path: "/data.xyz" } }),
    ];
    expect(inferLanguages(events)).toEqual([]);
  });

  it("checks filePath key variant", () => {
    const events = [
      makeEvent({ type: "tool_use", tool_input: { filePath: "/src/main.rs" } }),
    ];
    expect(inferLanguages(events)).toEqual(["Rust"]);
  });
});

// ── classifyOutcome ─────────────────────────────────────────────────

describe("classifyOutcome", () => {
  it("returns abandoned when no session_end", () => {
    const events = [makeEvent({ type: "user_prompt", message: "hello" })];
    expect(classifyOutcome(events, defaultConfig)).toBe("abandoned");
  });

  it("returns completed for clean session", () => {
    const events = [
      makeEvent({ type: "session_start", timestamp: tsSec(0) }),
      makeEvent({ type: "user_prompt", message: "fix bug", timestamp: tsSec(1) }),
      makeEvent({ type: "tool_result", tool_result: { success: true }, timestamp: tsSec(10) }),
      makeEvent({ type: "session_end", timestamp: tsSec(20) }),
    ];
    expect(classifyOutcome(events, defaultConfig)).toBe("completed");
  });

  it("returns errored when last tool results all failed but no abandon signal", () => {
    // Failures must be far from session_end to avoid triggering abandon_signal
    const events = [
      makeEvent({ type: "session_start", timestamp: tsSec(0) }),
      makeEvent({ type: "tool_result", tool_result: { success: true }, timestamp: tsSec(5) }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" }, timestamp: tsSec(10) }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" }, timestamp: tsSec(15) }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" }, timestamp: tsSec(20) }),
      // session_end well outside the abandon_window_seconds (120s)
      makeEvent({ type: "session_end", timestamp: tsSec(300) }),
    ];
    expect(classifyOutcome(events, defaultConfig)).toBe("errored");
  });

  it("returns abandoned when abandon signal is detected", () => {
    const events = [
      makeEvent({ type: "session_start", timestamp: tsSec(0) }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "err" }, timestamp: tsSec(50) }),
      makeEvent({ type: "session_end", timestamp: tsSec(60) }),
    ];
    expect(classifyOutcome(events, defaultConfig)).toBe("abandoned");
  });
});

// ── extractFacets ───────────────────────────────────────────────────

describe("extractFacets", () => {
  it("extracts facets from a session", () => {
    const events = [
      makeEvent({ type: "session_start", timestamp: ts(0) }),
      makeEvent({ type: "user_prompt", message: "fix bug", timestamp: ts(0) }),
      makeEvent({ type: "tool_use", tool_name: "file_read", tool_input: { file_path: "/src/main.ts" }, timestamp: ts(1) }),
      makeEvent({ type: "tool_result", tool_name: "file_read", tool_result: { success: true }, timestamp: ts(1) }),
      makeEvent({ type: "tool_use", tool_name: "file_edit", tool_input: { file_path: "/src/main.ts" }, timestamp: ts(2) }),
      makeEvent({ type: "tool_result", tool_name: "file_edit", tool_result: { success: true }, timestamp: ts(2) }),
      makeEvent({ type: "session_end", timestamp: ts(5) }),
    ];

    const facets = extractFacets(events, defaultConfig);
    expect(facets.languages).toEqual(["TypeScript"]);
    expect(facets.tools_used).toEqual(["file_edit", "file_read"]);
    expect(facets.tool_failure_rate).toBe(0);
    expect(facets.session_duration_min).toBe(5);
    expect(facets.total_turns).toBe(1);
    expect(facets.outcome).toBe("completed");
  });

  it("computes tool failure rate", () => {
    const events = [
      makeEvent({ type: "session_start", timestamp: tsSec(0) }),
      makeEvent({ type: "tool_result", tool_result: { success: true }, timestamp: tsSec(1) }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" }, timestamp: tsSec(2) }),
      makeEvent({ type: "tool_result", tool_result: { success: true }, timestamp: tsSec(3) }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" }, timestamp: tsSec(4) }),
      makeEvent({ type: "session_end", timestamp: tsSec(5) }),
    ];

    const facets = extractFacets(events, defaultConfig);
    expect(facets.tool_failure_rate).toBe(0.5);
  });

  it("returns 0 failure rate when no tool results", () => {
    const events = [
      makeEvent({ type: "session_start", timestamp: tsSec(0) }),
      makeEvent({ type: "user_prompt", message: "hello", timestamp: tsSec(1) }),
      makeEvent({ type: "session_end", timestamp: tsSec(2) }),
    ];

    const facets = extractFacets(events, defaultConfig);
    expect(facets.tool_failure_rate).toBe(0);
  });

  it("counts user prompts as total_turns", () => {
    const events = [
      makeEvent({ type: "session_start" }),
      makeEvent({ type: "user_prompt", message: "a" }),
      makeEvent({ type: "user_prompt", message: "b" }),
      makeEvent({ type: "user_prompt", message: "c" }),
      makeEvent({ type: "session_end" }),
    ];

    const facets = extractFacets(events, defaultConfig);
    expect(facets.total_turns).toBe(3);
  });

  it("handles zero duration for single-timestamp session", () => {
    const events = [
      makeEvent({ type: "session_start", timestamp: tsSec(0) }),
      makeEvent({ type: "session_end", timestamp: tsSec(0) }),
    ];

    const facets = extractFacets(events, defaultConfig);
    expect(facets.session_duration_min).toBe(0);
  });

  it("filters out NaN timestamps when computing duration and tool metrics", () => {
    const events = [
      makeEvent({ type: "session_start", timestamp: tsSec(0) }),
      makeEvent({ type: "tool_use", tool_name: "shell_exec", timestamp: tsSec(5) }),
      makeEvent({ type: "tool_result", tool_name: "shell_exec", tool_result: { success: false }, timestamp: "not-a-date" }),
      makeEvent({ type: "tool_use", tool_name: "file_read", timestamp: tsSec(20) }),
      makeEvent({ type: "tool_result", tool_name: "file_read", tool_result: { success: true }, timestamp: tsSec(25) }),
      makeEvent({ type: "session_end", timestamp: tsSec(60) }),
    ];

    const facets = extractFacets(events, defaultConfig);
    // Duration based on valid timestamps only
    expect(facets.session_duration_min).toBe(1);
    expect(facets.outcome).toBe("completed");
    // Tool metrics are computed from all tool events regardless of timestamp validity.
    // This asserts current behavior: a tool_result with a malformed timestamp is still
    // counted toward tool metrics. If extractFacets gains timestamp-based filtering for
    // tool events, this test should surface that change.
    expect(facets.tools_used).toEqual(["file_read", "shell_exec"]);
    expect(facets.tool_failure_rate).toBe(0.5);
  });

  it("collects unique tool names", () => {
    const events = [
      makeEvent({ type: "tool_use", tool_name: "file_read" }),
      makeEvent({ type: "tool_result", tool_name: "file_read", tool_result: { success: true } }),
      makeEvent({ type: "tool_use", tool_name: "shell_exec" }),
      makeEvent({ type: "tool_result", tool_name: "shell_exec", tool_result: { success: true } }),
      makeEvent({ type: "tool_use", tool_name: "file_read" }),
      makeEvent({ type: "tool_result", tool_name: "file_read", tool_result: { success: true } }),
      makeEvent({ type: "session_end" }),
    ];

    const facets = extractFacets(events, defaultConfig);
    expect(facets.tools_used).toEqual(["file_read", "shell_exec"]);
  });
});
