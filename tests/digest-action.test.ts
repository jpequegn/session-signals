import { describe, it, expect } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type {
  Config,
  FrictionSignal,
  Pattern,
  SignalRecord,
} from "../src/lib/types.js";
import type { AnalysisResult } from "../src/lib/pattern-analyzer.js";
import type { BeadsActionResult } from "../src/actions/beads.js";
import {
  generateDigestMarkdown,
  executeDigestAction,
} from "../src/actions/digest.js";
import type { DigestInput } from "../src/actions/digest.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    version: "1",
    tagger: {
      rephrase_threshold: 3,
      rephrase_similarity: 0.8,
      tool_failure_cascade_min: 3,
      context_churn_threshold: 2,
      abandon_window_seconds: 120,
      stall_threshold_seconds: 300,
      retry_loop_min: 3,
      retry_similarity: 0.8,
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
        enabled: false,
        min_severity: "high",
        min_frequency: 3,
        branch_prefix: "signals/fix-",
        branch_ttl_days: 7,
        allowed_tools: [],
      },
    },
    harnesses: {
      claude_code: { enabled: true, events_dir: "~/.claude/projects" },
      gemini_cli: { enabled: false, events_dir: "~/.gemini/sessions" },
      pi_coding_agent: { enabled: false, events_dir: "~/.pi/sessions" },
    },
    scope_rules: {
      pai_paths: ["/Users/user/.pai"],
      ignore_paths: ["/tmp"],
    },
    ...overrides,
  };
}

function makeSignal(overrides?: Partial<FrictionSignal>): FrictionSignal {
  return {
    type: "tool_failure_cascade",
    severity: "medium",
    count: 3,
    context: "3 consecutive tool failures",
    evidence: { event_indices: [10, 11, 12] },
    ...overrides,
  };
}

function makeSignalRecord(overrides?: Partial<SignalRecord>): SignalRecord {
  return {
    session_id: "sess-001",
    timestamp: "2026-02-05T10:00:00Z",
    project: "/home/user/project",
    scope: "project:/home/user/project",
    signals: [makeSignal()],
    facets: {
      languages: ["typescript"],
      tools_used: ["Write", "Bash"],
      tool_failure_rate: 0.2,
      session_duration_min: 30,
      total_turns: 10,
      outcome: "completed",
    },
    ...overrides,
  };
}

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

function makeAnalysisResult(overrides?: Partial<AnalysisResult>): AnalysisResult {
  return {
    scope: "project:/home/user/project",
    analysis: {
      patterns: [makePattern()],
      delight_patterns: [],
      summary: "One recurring friction pattern detected.",
    },
    skipped: false,
    ...overrides,
  };
}

function makeInput(overrides?: Partial<DigestInput>): DigestInput {
  return {
    analysisResults: [makeAnalysisResult()],
    signalRecords: [makeSignalRecord()],
    config: makeConfig(),
    ...overrides,
  };
}

// ── generateDigestMarkdown ──────────────────────────────────────────

describe("generateDigestMarkdown", () => {
  it("includes title with today's date", () => {
    const now = new Date();
    const md = generateDigestMarkdown(makeInput(), now);
    const today = now.toISOString().slice(0, 10);
    expect(md).toContain(`# Session Signals Digest — ${today}`);
  });

  it("includes analysis summary as blockquote", () => {
    const md = generateDigestMarkdown(makeInput());
    expect(md).toContain("> One recurring friction pattern detected.");
  });

  it("omits summary blockquote when summary is empty", () => {
    const input = makeInput({
      analysisResults: [makeAnalysisResult({
        analysis: { patterns: [], delight_patterns: [], summary: "" },
      })],
    });
    const md = generateDigestMarkdown(input);
    expect(md).not.toContain("> ");
  });

  // Overview section
  it("includes overview table with session count", () => {
    const md = generateDigestMarkdown(makeInput());
    expect(md).toContain("## Overview");
    expect(md).toContain("| Sessions analyzed | 1 |");
  });

  it("counts unique sessions", () => {
    const input = makeInput({
      signalRecords: [
        makeSignalRecord({ session_id: "sess-001" }),
        makeSignalRecord({ session_id: "sess-001" }),
        makeSignalRecord({ session_id: "sess-002" }),
      ],
    });
    const md = generateDigestMarkdown(input);
    expect(md).toContain("| Sessions analyzed | 2 |");
  });

  it("counts signals by severity", () => {
    const input = makeInput({
      signalRecords: [
        makeSignalRecord({ signals: [
          makeSignal({ severity: "high" }),
          makeSignal({ severity: "medium" }),
          makeSignal({ severity: "low" }),
          makeSignal({ severity: "low" }),
        ]}),
      ],
    });
    const md = generateDigestMarkdown(input);
    expect(md).toContain("| Total signals | 4 |");
    expect(md).toContain("| High severity | 1 |");
    expect(md).toContain("| Medium severity | 1 |");
    expect(md).toContain("| Low severity | 2 |");
  });

  it("counts patterns from analysis", () => {
    const input = makeInput({
      analysisResults: [
        makeAnalysisResult({
          analysis: {
            patterns: [makePattern(), makePattern({ id: "pat-2" })],
            delight_patterns: [],
            summary: "",
          },
        }),
      ],
    });
    const md = generateDigestMarkdown(input);
    expect(md).toContain("| Patterns identified | 2 |");
  });

  it("counts autofix branches", () => {
    const input = makeInput({
      autofixBranches: ["signals/fix-001", "signals/fix-002"],
    });
    const md = generateDigestMarkdown(input);
    expect(md).toContain("| Auto-fix attempts | 2 |");
  });

  // Friction patterns section
  it("includes friction patterns with details", () => {
    const md = generateDigestMarkdown(makeInput());
    expect(md).toContain("## Friction Patterns");
    expect(md).toContain("Repeated shell failures in tests");
    expect(md).toContain("- **Severity:** medium");
    expect(md).toContain("- **Frequency:** 3 sessions");
    expect(md).toContain("- **Trend:** → stable");
    expect(md).toContain("- **Root cause:** Missing test dependency");
    expect(md).toContain("- **Suggested fix:** Install missing dependency");
  });

  it("shows 'No friction patterns detected' when empty", () => {
    const input = makeInput({
      analysisResults: [makeAnalysisResult({
        analysis: { patterns: [], delight_patterns: [], summary: "" },
      })],
    });
    const md = generateDigestMarkdown(input);
    expect(md).toContain("No friction patterns detected.");
  });

  it("includes severity emoji for high", () => {
    const input = makeInput({
      analysisResults: [makeAnalysisResult({
        analysis: {
          patterns: [makePattern({ severity: "high", description: "Critical bug" })],
          delight_patterns: [],
          summary: "",
        },
      })],
    });
    const md = generateDigestMarkdown(input);
    expect(md).toContain("### 🔴 Critical bug");
  });

  it("includes trend arrows", () => {
    const input = makeInput({
      analysisResults: [makeAnalysisResult({
        analysis: {
          patterns: [makePattern({ trend: "increasing" })],
          delight_patterns: [],
          summary: "",
        },
      })],
    });
    const md = generateDigestMarkdown(input);
    expect(md).toContain("↗️ increasing");
  });

  it("includes auto-fixable indicator", () => {
    const input = makeInput({
      analysisResults: [makeAnalysisResult({
        analysis: {
          patterns: [makePattern({ auto_fixable: true })],
          delight_patterns: [],
          summary: "",
        },
      })],
    });
    const md = generateDigestMarkdown(input);
    expect(md).toContain("- **Auto-fixable:** Yes");
  });

  it("omits auto-fixable when false", () => {
    const md = generateDigestMarkdown(makeInput());
    expect(md).not.toContain("Auto-fixable");
  });

  it("includes beads issue when created", () => {
    const input = makeInput({
      beadsResults: [{
        pattern_id: "pat-20260205-001",
        action: "created",
        issue_title: "[signals] Shell failures",
      }],
    });
    const md = generateDigestMarkdown(input);
    expect(md).toContain("- **Beads issue:** [signals] Shell failures");
  });

  it("includes beads issue when updated", () => {
    const input = makeInput({
      beadsResults: [{
        pattern_id: "pat-20260205-001",
        action: "updated",
        issue_title: "[signals] Shell failures",
      }],
    });
    const md = generateDigestMarkdown(input);
    expect(md).toContain("- **Beads issue:** [signals] Shell failures");
  });

  it("omits beads issue when skipped", () => {
    const input = makeInput({
      beadsResults: [{
        pattern_id: "pat-20260205-001",
        action: "skipped",
        reason: "Below threshold",
      }],
    });
    const md = generateDigestMarkdown(input);
    expect(md).not.toContain("Beads issue");
  });

  it("shows affected files", () => {
    const input = makeInput({
      analysisResults: [makeAnalysisResult({
        analysis: {
          patterns: [makePattern({ affected_files: ["/src/a.ts", "/src/b.ts"] })],
          delight_patterns: [],
          summary: "",
        },
      })],
    });
    const md = generateDigestMarkdown(input);
    expect(md).toContain("- **Affected files:** /src/a.ts, /src/b.ts");
  });

  it("omits affected files when empty", () => {
    const input = makeInput({
      analysisResults: [makeAnalysisResult({
        analysis: {
          patterns: [makePattern({ affected_files: [] })],
          delight_patterns: [],
          summary: "",
        },
      })],
    });
    const md = generateDigestMarkdown(input);
    expect(md).not.toContain("Affected files");
  });

  // Delight patterns section
  it("includes delight patterns", () => {
    const input = makeInput({
      analysisResults: [makeAnalysisResult({
        analysis: {
          patterns: [],
          delight_patterns: [
            { description: "Fast tool execution", insight: "Average < 1s" },
          ],
          summary: "",
        },
      })],
    });
    const md = generateDigestMarkdown(input);
    expect(md).toContain("## Delight Patterns");
    expect(md).toContain("- **Fast tool execution** — Average < 1s");
  });

  it("shows 'No delight patterns identified' when empty", () => {
    const md = generateDigestMarkdown(makeInput());
    expect(md).toContain("No delight patterns identified.");
  });

  // Trend table section
  it("includes 7-day trend table", () => {
    const md = generateDigestMarkdown(makeInput());
    expect(md).toContain("## 7-Day Trend Table");
    expect(md).toContain("| Date | Sessions | Signals | High | Medium | Low |");
  });

  it("trend table has correct number of rows for lookback_days", () => {
    const md = generateDigestMarkdown(makeInput());
    // 7 days of data rows + header + separator + section header + empty lines
    const tableRows = md.split("\n").filter((l) => l.startsWith("| 20"));
    expect(tableRows.length).toBe(7);
  });

  it("trend table counts signals for matching days", () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const input = makeInput({
      signalRecords: [
        makeSignalRecord({
          session_id: "sess-today",
          timestamp: `${today}T10:00:00Z`,
          signals: [makeSignal({ severity: "high" }), makeSignal({ severity: "low" })],
        }),
      ],
    });
    const md = generateDigestMarkdown(input, now);
    // Find the row for today
    const todayRow = md.split("\n").find((l) => l.startsWith(`| ${today}`));
    expect(todayRow).toBeDefined();
    expect(todayRow).toContain("| 1 |"); // 1 session
    expect(todayRow).toContain("| 2 |"); // 2 signals
  });

  // Configuration section
  it("includes configuration table", () => {
    const md = generateDigestMarkdown(makeInput());
    expect(md).toContain("## Configuration");
    expect(md).toContain("| Model | llama3.2 |");
    expect(md).toContain("| Lookback days | 7 |");
    expect(md).toContain("| Min session signals | 1 |");
    expect(md).toContain("| Auto-fix enabled | false |");
    expect(md).toContain("| Beads enabled | true |");
  });

  // Scope breakdown section
  it("includes scope breakdown table", () => {
    const md = generateDigestMarkdown(makeInput());
    expect(md).toContain("## Scope Breakdown");
    expect(md).toContain("| project:/home/user/project | 1 | 1 |");
  });

  it("sorts scope breakdown by signal count descending", () => {
    const input = makeInput({
      signalRecords: [
        makeSignalRecord({
          scope: "project:/home/user/a",
          signals: [makeSignal()],
        }),
        makeSignalRecord({
          scope: "project:/home/user/b",
          signals: [makeSignal(), makeSignal(), makeSignal()],
        }),
      ],
    });
    const md = generateDigestMarkdown(input);
    const lines = md.split("\n");
    // Filter to table rows in scope breakdown (start with "| project:")
    const scopeLines = lines.filter((l) => l.startsWith("| project:/home/user/"));
    expect(scopeLines.length).toBe(2);
    // b should come first (3 signals) before a (1 signal)
    expect(scopeLines[0]).toContain("project:/home/user/b");
    expect(scopeLines[1]).toContain("project:/home/user/a");
  });

  it("shows 'No data available' for empty records", () => {
    const input = makeInput({ signalRecords: [] });
    const md = generateDigestMarkdown(input);
    expect(md).toContain("No data available.");
  });

  // Multiple analysis results
  it("combines patterns from multiple analysis results", () => {
    const input = makeInput({
      analysisResults: [
        makeAnalysisResult({
          scope: "project:/a",
          analysis: {
            patterns: [makePattern({ id: "p1", description: "Pattern A" })],
            delight_patterns: [],
            summary: "Summary A",
          },
        }),
        makeAnalysisResult({
          scope: "project:/b",
          analysis: {
            patterns: [makePattern({ id: "p2", description: "Pattern B" })],
            delight_patterns: [],
            summary: "Summary B",
          },
        }),
      ],
    });
    const md = generateDigestMarkdown(input);
    expect(md).toContain("Pattern A");
    expect(md).toContain("Pattern B");
    expect(md).toContain("> Summary A");
    expect(md).toContain("> Summary B");
  });

  // Empty input
  it("handles empty input gracefully", () => {
    const input = makeInput({
      analysisResults: [],
      signalRecords: [],
    });
    const md = generateDigestMarkdown(input);
    expect(md).toContain("# Session Signals Digest");
    expect(md).toContain("No friction patterns detected.");
    expect(md).toContain("No delight patterns identified.");
    expect(md).toContain("No data available.");
  });

  // Defaults for optional fields
  it("defaults beadsResults to empty", () => {
    const input: DigestInput = {
      analysisResults: [makeAnalysisResult()],
      signalRecords: [makeSignalRecord()],
      config: makeConfig(),
    };
    // Should not throw
    const md = generateDigestMarkdown(input);
    expect(md).toContain("## Friction Patterns");
  });

  it("defaults autofixBranches to empty", () => {
    const input: DigestInput = {
      analysisResults: [],
      signalRecords: [],
      config: makeConfig(),
    };
    const md = generateDigestMarkdown(input);
    expect(md).toContain("| Auto-fix attempts | 0 |");
  });
});

// ── executeDigestAction ─────────────────────────────────────────────

describe("executeDigestAction", () => {
  it("returns null when digest is disabled", async () => {
    const input = makeInput({
      config: makeConfig({
        actions: {
          beads: { enabled: true, min_severity: "medium", min_frequency: 2, title_prefix: "[signals]" },
          digest: { enabled: false, output_dir: "/tmp/test-digest" },
          autofix: { enabled: false, min_severity: "high", min_frequency: 3, branch_prefix: "signals/fix-", branch_ttl_days: 7, allowed_tools: [] },
        },
      }),
    });
    const result = await executeDigestAction(input);
    expect(result).toBeNull();
  });

  it("writes digest file and returns result", async () => {
    const dir = join(tmpdir(), `digest-test-${Date.now()}`);
    const input = makeInput({
      config: makeConfig({
        actions: {
          beads: { enabled: true, min_severity: "medium", min_frequency: 2, title_prefix: "[signals]" },
          digest: { enabled: true, output_dir: dir },
          autofix: { enabled: false, min_severity: "high", min_frequency: 3, branch_prefix: "signals/fix-", branch_ttl_days: 7, allowed_tools: [] },
        },
      }),
    });

    try {
      const result = await executeDigestAction(input);
      expect(result).not.toBeNull();
      expect(result!.path).toContain("_digest.md");
      expect(result!.markdown).toContain("# Session Signals Digest");

      // Verify file was actually written
      const contents = await readFile(result!.path, "utf-8");
      expect(contents).toBe(result!.markdown);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates output directory if it does not exist", async () => {
    const base = join(tmpdir(), `digest-test-${Date.now()}`);
    const dir = join(base, "nested", "dir");
    const input = makeInput({
      config: makeConfig({
        actions: {
          beads: { enabled: true, min_severity: "medium", min_frequency: 2, title_prefix: "[signals]" },
          digest: { enabled: true, output_dir: dir },
          autofix: { enabled: false, min_severity: "high", min_frequency: 3, branch_prefix: "signals/fix-", branch_ttl_days: 7, allowed_tools: [] },
        },
      }),
    });

    try {
      const result = await executeDigestAction(input);
      expect(result).not.toBeNull();
      const contents = await readFile(result!.path, "utf-8");
      expect(contents).toContain("# Session Signals Digest");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("uses today's date in filename", async () => {
    const dir = join(tmpdir(), `digest-test-${Date.now()}`);
    const now = new Date();
    const input = makeInput({
      config: makeConfig({
        actions: {
          beads: { enabled: true, min_severity: "medium", min_frequency: 2, title_prefix: "[signals]" },
          digest: { enabled: true, output_dir: dir },
          autofix: { enabled: false, min_severity: "high", min_frequency: 3, branch_prefix: "signals/fix-", branch_ttl_days: 7, allowed_tools: [] },
        },
      }),
    });

    try {
      const result = await executeDigestAction(input, now);
      const today = now.toISOString().slice(0, 10);
      expect(result!.path).toContain(`${today}_digest.md`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("expands ~/ prefix in output_dir to home directory", async () => {
    const subdir = `digest-test-${Date.now()}`;
    const input = makeInput({
      config: makeConfig({
        actions: {
          beads: { enabled: true, min_severity: "medium", min_frequency: 2, title_prefix: "[signals]" },
          digest: { enabled: true, output_dir: `~/${subdir}` },
          autofix: { enabled: false, min_severity: "high", min_frequency: 3, branch_prefix: "signals/fix-", branch_ttl_days: 7, allowed_tools: [] },
        },
      }),
    });

    const expandedDir = join(homedir(), subdir);
    try {
      const result = await executeDigestAction(input);
      expect(result).not.toBeNull();
      expect(result!.path).toStartWith(expandedDir);
    } finally {
      await rm(expandedDir, { recursive: true, force: true });
    }
  });
});
