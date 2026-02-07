import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code.js";
import {
  collectSignals,
  buildSignalRecord,
  writeSignalRecord,
  resolveScope,
} from "../../src/lib/tagger.js";
import {
  loadSignalRecords,
  groupByScope,
  computeDailyTrends,
  classifyTrend,
  dateRange,
} from "../../src/lib/pattern-analyzer.js";
import { generateDigestMarkdown } from "../../src/actions/digest.js";
import { meetsThreshold, buildIssueTitle, findExistingIssue } from "../../src/actions/beads.js";
import {
  meetsAutoFixThreshold,
  buildFixPrompt,
  buildBranchName,
} from "../../src/actions/autofix.js";
import type {
  Config,
  NormalizedEvent,
  FrictionSignal,
  Pattern,
  SignalRecord,
} from "../../src/lib/types.js";
import type { AnalysisResult } from "../../src/lib/pattern-analyzer.js";
import type { DigestInput } from "../../src/actions/digest.js";

// ── Shared config ───────────────────────────────────────────────────

const testConfig: Config = {
  version: "1",
  tagger: {
    rephrase_threshold: 3,
    rephrase_similarity: 0.6,
    tool_failure_cascade_min: 3,
    context_churn_threshold: 2,
    abandon_window_seconds: 120,
    stall_threshold_seconds: 60,
    retry_loop_min: 3,
    retry_similarity: 0.7,
  },
  analyzer: {
    model: "llama3.2",
    ollama_url: "http://localhost:11434",
    lookback_days: 7,
    min_session_signals: 1,
  },
  actions: {
    beads: {
      enabled: true,
      min_severity: "medium",
      min_frequency: 2,
      title_prefix: "[signals]",
    },
    digest: {
      enabled: true,
      output_dir: "~/signals-digest",
    },
    autofix: {
      enabled: true,
      min_severity: "high",
      min_frequency: 3,
      branch_prefix: "signals/fix-",
      branch_ttl_days: 14,
      allowed_tools: ["Edit", "Write", "Read"],
    },
  },
  harnesses: {
    claude_code: { enabled: true, events_dir: "" },
    gemini_cli: { enabled: false, events_dir: "" },
    pi_coding_agent: { enabled: false, events_dir: "" },
  },
  scope_rules: {
    pai_paths: ["/home/user/.pai"],
    ignore_paths: ["/tmp"],
  },
};

// ── Fixture paths ───────────────────────────────────────────────────

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const FRICTION_FIXTURE = join(FIXTURES_DIR, "claude-code-session-friction.jsonl");
const CLEAN_FIXTURE = join(FIXTURES_DIR, "claude-code-session-clean.jsonl");
const MULTI_DAY_FIXTURE = join(FIXTURES_DIR, "multi-day-signals.jsonl");

// ── Stage 1: Raw events → Normalized events ─────────────────────────

describe("Stage 1: Event parsing", () => {
  it("parses friction session fixture into normalized events", async () => {
    const raw = await readFile(FRICTION_FIXTURE, "utf-8");
    const adapter = new ClaudeCodeAdapter({ eventsDir: "" });
    const events = adapter.parseEvents(raw);

    expect(events.length).toBeGreaterThan(0);

    // Verify session boundaries
    const sessionStarts = events.filter((e) => e.type === "session_start");
    const sessionEnds = events.filter((e) => e.type === "session_end");
    expect(sessionStarts.length).toBe(1);
    expect(sessionEnds.length).toBe(1);

    // Verify all events have required fields
    for (const event of events) {
      expect(event.id).toBeDefined();
      expect(event.timestamp).toBeDefined();
      expect(event.harness).toBe("claude_code");
      expect(event.session_id).toBe("sess-friction-001");
    }
  });

  it("parses clean session fixture into normalized events", async () => {
    const raw = await readFile(CLEAN_FIXTURE, "utf-8");
    const adapter = new ClaudeCodeAdapter({ eventsDir: "" });
    const events = adapter.parseEvents(raw);

    expect(events.length).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === "session_start").length).toBe(1);
    expect(events.filter((e) => e.type === "session_end").length).toBe(1);
  });

  it("maps Claude Code tool names to canonical names", async () => {
    const raw = await readFile(FRICTION_FIXTURE, "utf-8");
    const adapter = new ClaudeCodeAdapter({ eventsDir: "" });
    const events = adapter.parseEvents(raw);

    const toolUses = events.filter((e) => e.type === "tool_use");
    const toolNames = toolUses.map((e) => e.tool_name);

    // Bash → shell_exec, Read → file_read, Edit → file_edit
    expect(toolNames).toContain("shell_exec");
    expect(toolNames).toContain("file_read");
    expect(toolNames).toContain("file_edit");
  });

  it("captures tool failures in normalized events", async () => {
    const raw = await readFile(FRICTION_FIXTURE, "utf-8");
    const adapter = new ClaudeCodeAdapter({ eventsDir: "" });
    const events = adapter.parseEvents(raw);

    const failures = events.filter(
      (e) => e.type === "tool_result" && e.tool_result?.success === false,
    );
    expect(failures.length).toBeGreaterThanOrEqual(3);
  });

  it("captures user prompts in normalized events", async () => {
    const raw = await readFile(FRICTION_FIXTURE, "utf-8");
    const adapter = new ClaudeCodeAdapter({ eventsDir: "" });
    const events = adapter.parseEvents(raw);

    const prompts = events.filter((e) => e.type === "user_prompt");
    expect(prompts.length).toBeGreaterThanOrEqual(3);
    expect(prompts[0]!.message).toBeDefined();
  });
});

// ── Stage 2: Normalized events → Friction signals ───────────────────

describe("Stage 2: Signal detection", () => {
  it("detects friction signals from friction session", async () => {
    const raw = await readFile(FRICTION_FIXTURE, "utf-8");
    const adapter = new ClaudeCodeAdapter({ eventsDir: "" });
    const events = adapter.parseEvents(raw);

    const signals = collectSignals(events, testConfig);

    // Should detect at least tool_failure_cascade (6 consecutive failures)
    expect(signals.length).toBeGreaterThan(0);
    const types = signals.map((s) => s.type);
    expect(types).toContain("tool_failure_cascade");
  });

  it("detects multiple friction signals from friction session", async () => {
    const raw = await readFile(FRICTION_FIXTURE, "utf-8");
    const adapter = new ClaudeCodeAdapter({ eventsDir: "" });
    const events = adapter.parseEvents(raw);

    const signals = collectSignals(events, testConfig);
    const types = signals.map((s) => s.type);

    // Should detect tool failures, retry loops, and/or abandon signals
    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(types).toContain("tool_failure_cascade");
    // At least one additional signal beyond tool_failure_cascade
    expect(types.filter((t) => t !== "tool_failure_cascade").length).toBeGreaterThan(0);
  });

  it("detects no friction signals from clean session", async () => {
    const raw = await readFile(CLEAN_FIXTURE, "utf-8");
    const adapter = new ClaudeCodeAdapter({ eventsDir: "" });
    const events = adapter.parseEvents(raw);

    const signals = collectSignals(events, testConfig);

    expect(signals.length).toBe(0);
  });

  it("all signals have required fields", async () => {
    const raw = await readFile(FRICTION_FIXTURE, "utf-8");
    const adapter = new ClaudeCodeAdapter({ eventsDir: "" });
    const events = adapter.parseEvents(raw);
    const signals = collectSignals(events, testConfig);

    for (const signal of signals) {
      expect(signal.type).toBeDefined();
      expect(signal.severity).toBeDefined();
      expect(signal.count).toBeGreaterThan(0);
      expect(signal.context).toBeDefined();
      expect(signal.evidence.event_indices).toBeDefined();
    }
  });
});

// ── Stage 3: Events → Signal record → Written to disk ───────────────

describe("Stage 3: Signal record persistence", () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = join(tmpdir(), `signals-integration-${Date.now()}`);
    await mkdir(outputDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("builds and writes a signal record from friction session", async () => {
    const raw = await readFile(FRICTION_FIXTURE, "utf-8");
    const adapter = new ClaudeCodeAdapter({ eventsDir: "" });
    const events = adapter.parseEvents(raw);

    const record = buildSignalRecord(
      "sess-friction-001",
      events,
      testConfig,
      "/home/user/project",
    );

    expect(record.session_id).toBe("sess-friction-001");
    expect(record.scope).toBe("project:/home/user/project");
    expect(record.signals.length).toBeGreaterThan(0);
    expect(record.facets.outcome).toBeDefined();
    expect(record.facets.languages).toBeDefined();

    // Write and read back
    await writeSignalRecord(record, outputDir);

    const date = record.timestamp.slice(0, 10);
    const files = await readdir(outputDir);
    expect(files.length).toBe(1);
    expect(files[0]).toBe(`${date}_signals.jsonl`);

    const content = await readFile(join(outputDir, files[0]!), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]!) as SignalRecord;
    expect(parsed.session_id).toBe("sess-friction-001");
    expect(parsed.signals.length).toBe(record.signals.length);
  });

  it("builds clean signal record with no signals", async () => {
    const raw = await readFile(CLEAN_FIXTURE, "utf-8");
    const adapter = new ClaudeCodeAdapter({ eventsDir: "" });
    const events = adapter.parseEvents(raw);

    const record = buildSignalRecord(
      "sess-clean-001",
      events,
      testConfig,
      "/home/user/project",
    );

    expect(record.session_id).toBe("sess-clean-001");
    expect(record.signals.length).toBe(0);
    expect(record.facets.outcome).toBe("completed");
  });

  it("scope resolution works for project paths", () => {
    expect(resolveScope("/home/user/project", testConfig)).toBe(
      "project:/home/user/project",
    );
  });

  it("scope resolution works for PAI paths", () => {
    expect(resolveScope("/home/user/.pai", testConfig)).toBe("pai");
    expect(resolveScope("/home/user/.pai/skills", testConfig)).toBe("pai");
  });
});

// ── Stage 4: Multi-day signals → Trend analysis ─────────────────────

describe("Stage 4: Trend analysis", () => {
  let signalsDir: string;

  beforeEach(async () => {
    signalsDir = join(tmpdir(), `signals-trends-${Date.now()}`);
    await mkdir(signalsDir, { recursive: true });

    // Load the multi-day fixture and write records to per-day files
    const raw = await readFile(MULTI_DAY_FIXTURE, "utf-8");
    const records = raw.trim().split("\n").map((line) => JSON.parse(line) as SignalRecord);

    // Group by date and write
    const byDate = new Map<string, string[]>();
    for (const record of records) {
      const date = record.timestamp.slice(0, 10);
      const existing = byDate.get(date) ?? [];
      existing.push(JSON.stringify(record));
      byDate.set(date, existing);
    }

    for (const [date, lines] of byDate) {
      await writeFile(
        join(signalsDir, `${date}_signals.jsonl`),
        lines.join("\n") + "\n",
        "utf-8",
      );
    }
  });

  afterEach(async () => {
    await rm(signalsDir, { recursive: true, force: true });
  });

  it("loads signal records from multi-day fixture", async () => {
    const days = dateRange(7, new Date("2026-02-05"));
    const records = await loadSignalRecords(days, signalsDir);

    expect(records.length).toBe(7);
    // readdir order is not guaranteed — check all sessions are present
    const sessionIds = records.map((r) => r.session_id).sort();
    expect(sessionIds).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
  });

  it("groups records by scope", async () => {
    const days = dateRange(7, new Date("2026-02-05"));
    const records = await loadSignalRecords(days, signalsDir);
    const groups = groupByScope(records);

    expect(groups.size).toBe(1);
    expect(groups.has("project:/home/user/project")).toBe(true);
    expect(groups.get("project:/home/user/project")!.length).toBe(7);
  });

  it("computes daily trends with correct signal counts", async () => {
    const days = dateRange(7, new Date("2026-02-05"));
    const records = await loadSignalRecords(days, signalsDir);
    const trends = computeDailyTrends(records, days);

    expect(trends.length).toBe(7);

    // Day 1 (2026-01-30): tool_failure_cascade=3
    expect(trends[0]!.date).toBe("2026-01-30");
    expect(trends[0]!.counts["tool_failure_cascade"]).toBe(3);

    // Day 5 (2026-02-03): tool_failure_cascade=7, rephrase_storm=5, retry_loop=3
    expect(trends[4]!.date).toBe("2026-02-03");
    expect(trends[4]!.counts["tool_failure_cascade"]).toBe(7);
    expect(trends[4]!.counts["rephrase_storm"]).toBe(5);

    // Day 6 (2026-02-04): no signals
    expect(trends[5]!.date).toBe("2026-02-04");
    expect(Object.keys(trends[5]!.counts).length).toBe(0);
  });

  it("classifies tool_failure_cascade as increasing", async () => {
    const days = dateRange(7, new Date("2026-02-05"));
    const records = await loadSignalRecords(days, signalsDir);
    const trends = computeDailyTrends(records, days);

    // tool_failure_cascade: 3, 4, 5, 6, 7, 0, 8 — second half > first half
    const trend = classifyTrend("tool_failure_cascade", trends);
    expect(trend).toBe("increasing");
  });

  it("returns empty for non-existent signals directory", async () => {
    const days = dateRange(7, new Date("2026-02-05"));
    const records = await loadSignalRecords(days, "/nonexistent/path");
    expect(records.length).toBe(0);
  });
});

// ── Stage 5: Full pipeline → Digest ─────────────────────────────────

describe("Stage 5: Digest generation", () => {
  it("generates complete digest from friction session data", async () => {
    const raw = await readFile(FRICTION_FIXTURE, "utf-8");
    const adapter = new ClaudeCodeAdapter({ eventsDir: "" });
    const events = adapter.parseEvents(raw);

    const record = buildSignalRecord(
      "sess-friction-001",
      events,
      testConfig,
      "/home/user/project",
    );

    // Simulate analysis result
    const analysisResult: AnalysisResult = {
      scope: "project:/home/user/project",
      analysis: {
        patterns: [
          {
            id: "pat-20260205-001",
            type: "recurring_friction",
            scope: "project:/home/user/project",
            description: "Repeated test failures due to missing dependency",
            severity: "high",
            frequency: 3,
            trend: "increasing",
            root_cause_hypothesis: "jsonwebtoken module is not installed",
            suggested_fix: "Run npm install jsonwebtoken",
            auto_fixable: true,
            fix_scope: "project",
            affected_files: ["/home/user/project/src/login.ts"],
          },
        ],
        delight_patterns: [],
        summary: "Detected recurring test failure pattern.",
      },
      skipped: false,
    };

    const input: DigestInput = {
      analysisResults: [analysisResult],
      signalRecords: [record],
      config: testConfig,
    };

    const markdown = generateDigestMarkdown(input);

    // Verify all sections present
    expect(markdown).toContain("# Session Signals Digest");
    expect(markdown).toContain("## Overview");
    expect(markdown).toContain("## Friction Patterns");
    expect(markdown).toContain("## Delight Patterns");
    expect(markdown).toContain("## 7-Day Trend Table");
    expect(markdown).toContain("## Configuration");
    expect(markdown).toContain("## Scope Breakdown");

    // Verify content from our data
    expect(markdown).toContain("Repeated test failures");
    expect(markdown).toContain("jsonwebtoken");
    expect(markdown).toContain("project:/home/user/project");
  });

  it("generates clean digest with no patterns from clean session", async () => {
    const raw = await readFile(CLEAN_FIXTURE, "utf-8");
    const adapter = new ClaudeCodeAdapter({ eventsDir: "" });
    const events = adapter.parseEvents(raw);

    const record = buildSignalRecord(
      "sess-clean-001",
      events,
      testConfig,
      "/home/user/project",
    );

    const analysisResult: AnalysisResult = {
      scope: "project:/home/user/project",
      analysis: {
        patterns: [],
        delight_patterns: [
          { description: "Fast session completion", insight: "Session completed in under 2 minutes" },
        ],
        summary: "No friction detected.",
      },
      skipped: false,
    };

    const input: DigestInput = {
      analysisResults: [analysisResult],
      signalRecords: [record],
      config: testConfig,
    };

    const markdown = generateDigestMarkdown(input);

    expect(markdown).toContain("No friction patterns detected.");
    expect(markdown).toContain("Fast session completion");
    expect(markdown).toContain("| Total signals | 0 |");
  });
});

// ── Stage 6: Beads action integration ───────────────────────────────

describe("Stage 6: Beads threshold and title integration", () => {
  const pattern: Pattern = {
    id: "pat-20260205-001",
    type: "recurring_friction",
    scope: "project:/home/user/project",
    description: "Repeated test failures",
    severity: "high",
    frequency: 3,
    trend: "increasing",
    root_cause_hypothesis: "Missing dependency",
    suggested_fix: "Install dependency",
    auto_fixable: true,
    fix_scope: "project",
    affected_files: [],
  };

  it("pattern meets beads threshold", () => {
    expect(meetsThreshold(pattern, testConfig.actions.beads)).toBe(true);
  });

  it("builds correct issue title", () => {
    const title = buildIssueTitle(pattern, testConfig.actions.beads.title_prefix);
    expect(title).toBe("[signals] Repeated test failures");
  });

  it("findExistingIssue matches constructed title", () => {
    const title = buildIssueTitle(pattern, testConfig.actions.beads.title_prefix);
    const searchOutput = `SS-42  ${title}`;
    expect(findExistingIssue(searchOutput, title)).toBe("SS-42");
  });
});

// ── Stage 7: Autofix action integration ─────────────────────────────

describe("Stage 7: Autofix threshold and prompt integration", () => {
  const pattern: Pattern = {
    id: "pat-20260205-001",
    type: "recurring_friction",
    scope: "project:/home/user/project",
    description: "Repeated test failures",
    severity: "high",
    frequency: 3,
    trend: "increasing",
    root_cause_hypothesis: "Missing dependency",
    suggested_fix: "Install dependency",
    auto_fixable: true,
    fix_scope: "project",
    affected_files: ["/src/test.ts"],
  };

  it("pattern meets autofix threshold", () => {
    expect(meetsAutoFixThreshold(pattern, testConfig.actions.autofix)).toBe(true);
  });

  it("non-auto-fixable pattern does not meet threshold", () => {
    expect(meetsAutoFixThreshold(
      { ...pattern, auto_fixable: false },
      testConfig.actions.autofix,
    )).toBe(false);
  });

  it("builds correct branch name", () => {
    const branch = buildBranchName(pattern, testConfig.actions.autofix.branch_prefix);
    expect(branch).toBe("signals/fix-pat-20260205-001");
  });

  it("builds prompt with all pattern details", () => {
    const prompt = buildFixPrompt(pattern);
    expect(prompt).toContain("Repeated test failures");
    expect(prompt).toContain("Missing dependency");
    expect(prompt).toContain("Install dependency");
    expect(prompt).toContain("/src/test.ts");
    expect(prompt).toContain("Do NOT merge");
  });
});

// ── Cross-cutting: End-to-end pipeline coherence ────────────────────

describe("End-to-end pipeline coherence", () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = join(tmpdir(), `signals-e2e-${Date.now()}`);
    await mkdir(outputDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("full pipeline: parse → tag → persist → load → digest", async () => {
    // Step 1: Parse raw events
    const raw = await readFile(FRICTION_FIXTURE, "utf-8");
    const adapter = new ClaudeCodeAdapter({ eventsDir: "" });
    const events = adapter.parseEvents(raw);
    expect(events.length).toBeGreaterThan(0);

    // Step 2: Build signal record
    const record = buildSignalRecord(
      "sess-friction-001",
      events,
      testConfig,
      "/home/user/project",
    );
    expect(record.signals.length).toBeGreaterThan(0);

    // Step 3: Persist to disk
    await writeSignalRecord(record, outputDir);

    // Step 4: Load back
    const date = record.timestamp.slice(0, 10);
    const loaded = await loadSignalRecords([date], outputDir);
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.session_id).toBe("sess-friction-001");
    expect(loaded[0]!.signals.length).toBe(record.signals.length);

    // Step 5: Generate digest
    const analysisResult: AnalysisResult = {
      scope: "project:/home/user/project",
      analysis: {
        patterns: [{
          id: "pat-001",
          type: "recurring_friction",
          scope: "project:/home/user/project",
          description: "Test failures from fixture",
          severity: "high",
          frequency: 1,
          trend: "new",
          root_cause_hypothesis: "Missing dep",
          suggested_fix: "Install it",
          auto_fixable: true,
          fix_scope: "project",
          affected_files: [],
        }],
        delight_patterns: [],
        summary: "One pattern from e2e test.",
      },
      skipped: false,
    };

    const markdown = generateDigestMarkdown({
      analysisResults: [analysisResult],
      signalRecords: loaded,
      config: testConfig,
    });

    expect(markdown).toContain("# Session Signals Digest");
    expect(markdown).toContain("Test failures from fixture");
    expect(markdown).toContain("| Sessions analyzed | 1 |");
    // Signal count should match what we detected
    expect(markdown).toContain(`| Total signals | ${record.signals.length} |`);
  });

  it("clean session produces zero-signal digest", async () => {
    const raw = await readFile(CLEAN_FIXTURE, "utf-8");
    const adapter = new ClaudeCodeAdapter({ eventsDir: "" });
    const events = adapter.parseEvents(raw);

    const record = buildSignalRecord(
      "sess-clean-001",
      events,
      testConfig,
      "/home/user/project",
    );

    await writeSignalRecord(record, outputDir);

    const date = record.timestamp.slice(0, 10);
    const loaded = await loadSignalRecords([date], outputDir);

    const markdown = generateDigestMarkdown({
      analysisResults: [],
      signalRecords: loaded,
      config: testConfig,
    });

    expect(markdown).toContain("| Total signals | 0 |");
    expect(markdown).toContain("No friction patterns detected.");
  });
});
