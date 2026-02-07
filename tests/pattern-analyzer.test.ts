import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config, SignalRecord, PatternAnalysis } from "../src/lib/types.js";
import type { OllamaClient } from "../src/lib/ollama-client.js";
import {
  dateRange,
  loadSignalRecords,
  groupByScope,
  computeDailyTrends,
  classifyTrend,
  buildPrompt,
  analyzeScope,
  runAnalysis,
} from "../src/lib/pattern-analyzer.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    version: "1.0.0",
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
      beads: { enabled: true, min_severity: "medium", min_frequency: 2, title_prefix: "[signals]" },
      digest: { enabled: true, output_dir: "~/.claude/history/signals/digests" },
      autofix: { enabled: true, min_severity: "high", min_frequency: 3, branch_prefix: "signals/fix-", branch_ttl_days: 14, allowed_tools: ["file_edit", "file_write"] },
    },
    harnesses: {
      claude_code: { enabled: true, events_dir: "~/.claude/history/raw-outputs" },
      gemini_cli: { enabled: false, events_dir: "" },
      pi_coding_agent: { enabled: false, events_dir: "" },
    },
    scope_rules: {
      pai_paths: ["~/.claude"],
      ignore_paths: ["node_modules", ".git", "dist", "build"],
    },
    ...overrides,
  };
}

function makeSignalRecord(overrides?: Partial<SignalRecord>): SignalRecord {
  return {
    session_id: "sess-1",
    timestamp: "2026-02-05T10:00:00.000Z",
    project: "/home/user/project",
    scope: "project:/home/user/project",
    signals: [
      {
        type: "tool_failure_cascade",
        severity: "medium",
        count: 3,
        context: "3 consecutive tool failures",
        evidence: { event_indices: [1, 2, 3] },
      },
    ],
    facets: {
      languages: ["TypeScript"],
      tools_used: ["file_edit", "shell_exec"],
      tool_failure_rate: 0.3,
      session_duration_min: 15,
      total_turns: 5,
      outcome: "completed",
    },
    ...overrides,
  };
}

function mockOllamaClient(response?: PatternAnalysis): OllamaClient {
  const defaultResponse: PatternAnalysis = response ?? {
    patterns: [{
      id: "pat-20260205-001",
      type: "recurring_friction",
      scope: "project:/home/user/project",
      description: "Repeated shell failures",
      severity: "medium",
      frequency: 3,
      trend: "stable",
      root_cause_hypothesis: "Missing dependency",
      suggested_fix: "Install the dependency",
      auto_fixable: false,
      fix_scope: "project",
      affected_files: [],
    }],
    delight_patterns: [],
    summary: "Some friction detected",
  };

  return {
    generate: async () => JSON.stringify(defaultResponse),
    generateJSON: async <T>() => defaultResponse as unknown as T,
    isAvailable: async () => true,
  };
}

function mockUnavailableClient(): OllamaClient {
  return {
    generate: async () => { throw new Error("unavailable"); },
    generateJSON: async () => { throw new Error("unavailable"); },
    isAvailable: async () => false,
  };
}

// ── dateRange ───────────────────────────────────────────────────────

describe("dateRange", () => {
  it("generates correct number of dates", () => {
    const dates = dateRange(7, new Date("2026-02-07T12:00:00Z"));
    expect(dates).toHaveLength(7);
  });

  it("dates are in ascending order", () => {
    const dates = dateRange(3, new Date("2026-02-07T12:00:00Z"));
    expect(dates).toEqual(["2026-02-05", "2026-02-06", "2026-02-07"]);
  });

  it("handles single day", () => {
    const dates = dateRange(1, new Date("2026-02-07T12:00:00Z"));
    expect(dates).toEqual(["2026-02-07"]);
  });
});

// ── loadSignalRecords ───────────────────────────────────────────────

describe("loadSignalRecords", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "analyzer-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when dir does not exist", async () => {
    const records = await loadSignalRecords(["2026-02-05"], "/nonexistent");
    expect(records).toEqual([]);
  });

  it("loads records from matching date files", async () => {
    const record = makeSignalRecord();
    await writeFile(
      join(tmpDir, "2026-02-05_signals.jsonl"),
      JSON.stringify(record) + "\n",
    );

    const records = await loadSignalRecords(["2026-02-05"], tmpDir);
    expect(records).toHaveLength(1);
    expect(records[0]!.session_id).toBe("sess-1");
  });

  it("ignores non-matching date files", async () => {
    await writeFile(
      join(tmpDir, "2026-02-04_signals.jsonl"),
      JSON.stringify(makeSignalRecord()) + "\n",
    );

    const records = await loadSignalRecords(["2026-02-05"], tmpDir);
    expect(records).toEqual([]);
  });

  it("loads multiple records from multiple files", async () => {
    await writeFile(
      join(tmpDir, "2026-02-05_signals.jsonl"),
      JSON.stringify(makeSignalRecord({ session_id: "s1" })) + "\n" +
      JSON.stringify(makeSignalRecord({ session_id: "s2" })) + "\n",
    );
    await writeFile(
      join(tmpDir, "2026-02-06_signals.jsonl"),
      JSON.stringify(makeSignalRecord({ session_id: "s3", timestamp: "2026-02-06T10:00:00.000Z" })) + "\n",
    );

    const records = await loadSignalRecords(["2026-02-05", "2026-02-06"], tmpDir);
    expect(records).toHaveLength(3);
  });

  it("skips malformed JSONL lines", async () => {
    await writeFile(
      join(tmpDir, "2026-02-05_signals.jsonl"),
      "{bad json\n" + JSON.stringify(makeSignalRecord()) + "\n",
    );

    const records = await loadSignalRecords(["2026-02-05"], tmpDir);
    expect(records).toHaveLength(1);
  });
});

// ── groupByScope ────────────────────────────────────────────────────

describe("groupByScope", () => {
  it("groups records by scope", () => {
    const records = [
      makeSignalRecord({ scope: "pai" }),
      makeSignalRecord({ scope: "project:/a" }),
      makeSignalRecord({ scope: "pai" }),
      makeSignalRecord({ scope: "project:/b" }),
    ];

    const groups = groupByScope(records);
    expect(groups.size).toBe(3);
    expect(groups.get("pai")!.length).toBe(2);
    expect(groups.get("project:/a")!.length).toBe(1);
    expect(groups.get("project:/b")!.length).toBe(1);
  });

  it("returns empty map for empty input", () => {
    expect(groupByScope([]).size).toBe(0);
  });
});

// ── computeDailyTrends ──────────────────────────────────────────────

describe("computeDailyTrends", () => {
  it("computes counts per day per signal type", () => {
    const records = [
      makeSignalRecord({
        timestamp: "2026-02-05T10:00:00.000Z",
        signals: [
          { type: "tool_failure_cascade", severity: "medium", count: 3, context: "", evidence: { event_indices: [] } },
          { type: "context_churn", severity: "low", count: 2, context: "", evidence: { event_indices: [] } },
        ],
      }),
      makeSignalRecord({
        timestamp: "2026-02-05T14:00:00.000Z",
        signals: [
          { type: "tool_failure_cascade", severity: "high", count: 5, context: "", evidence: { event_indices: [] } },
        ],
      }),
    ];

    const trends = computeDailyTrends(records, ["2026-02-04", "2026-02-05", "2026-02-06"]);
    expect(trends).toHaveLength(3);
    expect(trends[0]!.counts).toEqual({}); // 2026-02-04: no signals
    expect(trends[1]!.counts["tool_failure_cascade"]).toBe(8); // 3 + 5
    expect(trends[1]!.counts["context_churn"]).toBe(2);
    expect(trends[2]!.counts).toEqual({}); // 2026-02-06: no signals
  });

  it("returns empty counts for days with no records", () => {
    const trends = computeDailyTrends([], ["2026-02-05"]);
    expect(trends).toHaveLength(1);
    expect(trends[0]!.counts).toEqual({});
  });
});

// ── classifyTrend ───────────────────────────────────────────────────

describe("classifyTrend", () => {
  it("returns 'new' when signal not present", () => {
    const trends = [
      { date: "2026-02-01", counts: {} },
      { date: "2026-02-02", counts: {} },
    ];
    expect(classifyTrend("tool_failure_cascade", trends)).toBe("new");
  });

  it("returns 'new' for signal only on the last day", () => {
    const trends = [
      { date: "2026-02-01", counts: {} },
      { date: "2026-02-02", counts: {} },
      { date: "2026-02-03", counts: { tool_failure_cascade: 3 } },
    ];
    expect(classifyTrend("tool_failure_cascade", trends)).toBe("new");
  });

  it("returns 'new' for fewer than 3 active days", () => {
    const trends = [
      { date: "2026-02-01", counts: { retry_loop: 1 } },
      { date: "2026-02-02", counts: {} },
      { date: "2026-02-03", counts: { retry_loop: 2 } },
    ];
    expect(classifyTrend("retry_loop", trends)).toBe("new");
  });

  it("returns 'increasing' when second half > first half", () => {
    const trends = [
      { date: "2026-02-01", counts: { retry_loop: 1 } },
      { date: "2026-02-02", counts: { retry_loop: 1 } },
      { date: "2026-02-03", counts: { retry_loop: 1 } },
      { date: "2026-02-04", counts: { retry_loop: 5 } },
      { date: "2026-02-05", counts: { retry_loop: 5 } },
      { date: "2026-02-06", counts: { retry_loop: 5 } },
    ];
    expect(classifyTrend("retry_loop", trends)).toBe("increasing");
  });

  it("returns 'decreasing' when second half < first half", () => {
    const trends = [
      { date: "2026-02-01", counts: { retry_loop: 5 } },
      { date: "2026-02-02", counts: { retry_loop: 5 } },
      { date: "2026-02-03", counts: { retry_loop: 5 } },
      { date: "2026-02-04", counts: { retry_loop: 1 } },
      { date: "2026-02-05", counts: { retry_loop: 1 } },
      { date: "2026-02-06", counts: { retry_loop: 1 } },
    ];
    expect(classifyTrend("retry_loop", trends)).toBe("decreasing");
  });

  it("returns 'stable' when halves are roughly equal", () => {
    const trends = [
      { date: "2026-02-01", counts: { retry_loop: 3 } },
      { date: "2026-02-02", counts: { retry_loop: 3 } },
      { date: "2026-02-03", counts: { retry_loop: 3 } },
      { date: "2026-02-04", counts: { retry_loop: 3 } },
      { date: "2026-02-05", counts: { retry_loop: 3 } },
      { date: "2026-02-06", counts: { retry_loop: 3 } },
    ];
    expect(classifyTrend("retry_loop", trends)).toBe("stable");
  });
});

// ── buildPrompt ─────────────────────────────────────────────────────

describe("buildPrompt", () => {
  it("includes scope in prompt", () => {
    const prompt = buildPrompt("project:/myapp", [makeSignalRecord()], []);
    expect(prompt).toContain("project:/myapp");
  });

  it("includes signal data", () => {
    const prompt = buildPrompt("pai", [makeSignalRecord()], []);
    expect(prompt).toContain("tool_failure_cascade");
    expect(prompt).toContain("consecutive tool failures");
  });

  it("includes trend table", () => {
    const trends = [{ date: "2026-02-05", counts: { retry_loop: 3 } }];
    const prompt = buildPrompt("pai", [makeSignalRecord()], trends);
    expect(prompt).toContain("2026-02-05: retry_loop=3");
  });

  it("requests JSON output matching PatternAnalysis schema", () => {
    const prompt = buildPrompt("pai", [makeSignalRecord()], []);
    expect(prompt).toContain("patterns");
    expect(prompt).toContain("delight_patterns");
    expect(prompt).toContain("summary");
    expect(prompt).toContain("root_cause_hypothesis");
    expect(prompt).toContain("suggested_fix");
  });
});

// ── analyzeScope ────────────────────────────────────────────────────

describe("analyzeScope", () => {
  it("returns analysis from Ollama", async () => {
    const config = makeConfig();
    const client = mockOllamaClient();
    const records = [makeSignalRecord()];
    const trends = [{ date: "2026-02-05", counts: { tool_failure_cascade: 3 } }];

    const result = await analyzeScope("project:/myapp", records, trends, client, config);
    expect(result.skipped).toBe(false);
    expect(result.analysis.patterns.length).toBeGreaterThan(0);
    expect(result.analysis.summary).toBeTruthy();
  });

  it("skips when Ollama is unavailable", async () => {
    const config = makeConfig();
    const client = mockUnavailableClient();
    const warnings: string[] = [];

    const result = await analyzeScope(
      "pai",
      [makeSignalRecord()],
      [],
      client,
      config,
      (msg) => warnings.push(msg),
    );

    expect(result.skipped).toBe(true);
    expect(result.analysis.patterns).toEqual([]);
    expect(warnings.some((w) => w.includes("not available"))).toBe(true);
  });

  it("skips when no records meet min_session_signals", async () => {
    const config = makeConfig();
    const client = mockOllamaClient();
    const records = [makeSignalRecord({ signals: [] })]; // no signals

    const result = await analyzeScope("pai", records, [], client, config);
    expect(result.skipped).toBe(true);
  });

  it("handles Ollama errors gracefully", async () => {
    const config = makeConfig();
    const client: OllamaClient = {
      generate: async () => { throw new Error("boom"); },
      generateJSON: async () => { throw new Error("boom"); },
      isAvailable: async () => true,
    };
    const warnings: string[] = [];

    const result = await analyzeScope(
      "pai",
      [makeSignalRecord()],
      [],
      client,
      config,
      (msg) => warnings.push(msg),
    );

    expect(result.skipped).toBe(true);
    expect(warnings.some((w) => w.includes("failed"))).toBe(true);
  });
});

// ── runAnalysis ─────────────────────────────────────────────────────

describe("runAnalysis", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "analyzer-run-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when no signal files", async () => {
    const config = makeConfig();
    const client = mockOllamaClient();

    const results = await runAnalysis(config, client, {
      signalsDir: tmpDir,
      referenceDate: new Date("2026-02-07T12:00:00Z"),
    });

    expect(results).toEqual([]);
  });

  it("analyzes signals grouped by scope", async () => {
    const r1 = makeSignalRecord({ scope: "project:/a", timestamp: "2026-02-05T10:00:00.000Z" });
    const r2 = makeSignalRecord({ scope: "project:/b", timestamp: "2026-02-05T11:00:00.000Z" });

    await writeFile(
      join(tmpDir, "2026-02-05_signals.jsonl"),
      JSON.stringify(r1) + "\n" + JSON.stringify(r2) + "\n",
    );

    const config = makeConfig();
    const client = mockOllamaClient();

    const results = await runAnalysis(config, client, {
      signalsDir: tmpDir,
      referenceDate: new Date("2026-02-07T12:00:00Z"),
    });

    expect(results).toHaveLength(2);
    const scopes = results.map((r) => r.scope).sort();
    expect(scopes).toEqual(["project:/a", "project:/b"]);
  });

  it("passes warnings through", async () => {
    await writeFile(
      join(tmpDir, "2026-02-05_signals.jsonl"),
      JSON.stringify(makeSignalRecord({ timestamp: "2026-02-05T10:00:00.000Z" })) + "\n",
    );

    const config = makeConfig();
    const client = mockUnavailableClient();
    const warnings: string[] = [];

    await runAnalysis(config, client, {
      signalsDir: tmpDir,
      referenceDate: new Date("2026-02-07T12:00:00Z"),
      warn: (msg) => warnings.push(msg),
    });

    expect(warnings.length).toBeGreaterThan(0);
  });
});
