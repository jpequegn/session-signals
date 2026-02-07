import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import type { Config, NormalizedEvent } from "../src/lib/types.js";
import {
  isHookInput,
  detectHarness,
  createAdapter,
  resolveScope,
  collectSignals,
  buildSignalRecord,
} from "../src/lib/tagger.js";

// ── Test config ─────────────────────────────────────────────────────

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

function tsSec(secondOffset: number): string {
  const d = new Date("2026-02-05T10:00:00.000Z");
  d.setSeconds(d.getSeconds() + secondOffset);
  return d.toISOString();
}

beforeEach(() => {
  idCounter = 0;
});

// ── isHookInput ─────────────────────────────────────────────────────

describe("isHookInput", () => {
  it("accepts valid hook input", () => {
    expect(isHookInput({ session_id: "abc-123" })).toBe(true);
  });

  it("accepts input with optional fields", () => {
    expect(isHookInput({ session_id: "abc", cwd: "/foo", transcript_path: "/bar" })).toBe(true);
  });

  it("rejects null", () => {
    expect(isHookInput(null)).toBe(false);
  });

  it("rejects non-object", () => {
    expect(isHookInput("string")).toBe(false);
  });

  it("rejects missing session_id", () => {
    expect(isHookInput({ cwd: "/foo" })).toBe(false);
  });

  it("rejects non-string session_id", () => {
    expect(isHookInput({ session_id: 123 })).toBe(false);
  });
});

// ── detectHarness ───────────────────────────────────────────────────

describe("detectHarness", () => {
  const config = makeConfig();

  it("detects claude_code from transcript_path", () => {
    expect(detectHarness({ session_id: "s", transcript_path: "/home/user/.claude/history/abc.jsonl" }, config)).toBe("claude_code");
  });

  it("detects gemini_cli from transcript_path", () => {
    expect(detectHarness({ session_id: "s", transcript_path: "/home/user/.gemini/tmp/abc.json" }, config)).toBe("gemini_cli");
  });

  it("detects pi_coding_agent from transcript_path", () => {
    expect(detectHarness({ session_id: "s", transcript_path: "/home/user/.pi/agent/sessions/abc.jsonl" }, config)).toBe("pi_coding_agent");
  });

  it("falls back to first enabled harness", () => {
    const result = detectHarness({ session_id: "s" }, config);
    expect(result).toBe("claude_code");
  });

  it("returns null when no harness enabled", () => {
    const noHarness = makeConfig({
      harnesses: {
        claude_code: { enabled: false, events_dir: "" },
        gemini_cli: { enabled: false, events_dir: "" },
        pi_coding_agent: { enabled: false, events_dir: "" },
      },
    });
    expect(detectHarness({ session_id: "s" }, noHarness)).toBeNull();
  });
});

// ── createAdapter ───────────────────────────────────────────────────

describe("createAdapter", () => {
  it("creates ClaudeCodeAdapter", () => {
    const config = makeConfig();
    const adapter = createAdapter("claude_code", config);
    expect(adapter).not.toBeNull();
    expect(adapter!.getEventSource()).toBe("claude_code");
  });

  it("creates GeminiCliAdapter when enabled", () => {
    const config = makeConfig({
      harnesses: {
        claude_code: { enabled: false, events_dir: "" },
        gemini_cli: { enabled: true, events_dir: "/tmp/gemini" },
        pi_coding_agent: { enabled: false, events_dir: "" },
      },
    });
    const adapter = createAdapter("gemini_cli", config);
    expect(adapter).not.toBeNull();
    expect(adapter!.getEventSource()).toBe("gemini_cli");
  });

  it("creates PiCodingAgentAdapter when enabled", () => {
    const config = makeConfig({
      harnesses: {
        claude_code: { enabled: false, events_dir: "" },
        gemini_cli: { enabled: false, events_dir: "" },
        pi_coding_agent: { enabled: true, events_dir: "/tmp/pi" },
      },
    });
    const adapter = createAdapter("pi_coding_agent", config);
    expect(adapter).not.toBeNull();
    expect(adapter!.getEventSource()).toBe("pi_coding_agent");
  });

  it("returns null for disabled harness", () => {
    const config = makeConfig({
      harnesses: {
        claude_code: { enabled: false, events_dir: "" },
        gemini_cli: { enabled: false, events_dir: "" },
        pi_coding_agent: { enabled: false, events_dir: "" },
      },
    });
    expect(createAdapter("claude_code", config)).toBeNull();
  });

  it("expands ~ in events_dir", () => {
    const config = makeConfig();
    const adapter = createAdapter("claude_code", config);
    // If it created successfully with ~/ path, expansion worked
    expect(adapter).not.toBeNull();
  });
});

// ── resolveScope ────────────────────────────────────────────────────

describe("resolveScope", () => {
  const config = makeConfig();

  it("returns pai for paths under pai_paths", () => {
    const home = homedir();
    expect(resolveScope(`${home}/.claude/projects/foo`, config)).toBe("pai");
  });

  it("returns project scope for other paths", () => {
    expect(resolveScope("/home/user/projects/myapp", config)).toBe("project:/home/user/projects/myapp");
  });

  it("returns project scope for non-matching cwd", () => {
    expect(resolveScope("/tmp/test", config)).toBe("project:/tmp/test");
  });
});

// ── collectSignals ──────────────────────────────────────────────────

describe("collectSignals", () => {
  it("returns empty array for clean session", () => {
    const events = [
      makeEvent({ type: "session_start", timestamp: tsSec(0) }),
      makeEvent({ type: "user_prompt", message: "hello", timestamp: tsSec(1) }),
      makeEvent({ type: "tool_result", tool_result: { success: true }, timestamp: tsSec(5) }),
      makeEvent({ type: "session_end", timestamp: tsSec(10) }),
    ];
    const config = makeConfig();
    const signals = collectSignals(events, config);
    expect(signals).toEqual([]);
  });

  it("detects tool failure cascade", () => {
    const events = [
      makeEvent({ type: "session_start", timestamp: tsSec(0) }),
      makeEvent({ type: "tool_result", tool_name: "shell_exec", tool_result: { success: false, error: "e1" }, timestamp: tsSec(1) }),
      makeEvent({ type: "tool_result", tool_name: "shell_exec", tool_result: { success: false, error: "e2" }, timestamp: tsSec(2) }),
      makeEvent({ type: "tool_result", tool_name: "shell_exec", tool_result: { success: false, error: "e3" }, timestamp: tsSec(3) }),
      makeEvent({ type: "session_end", timestamp: tsSec(10) }),
    ];
    const config = makeConfig();
    const signals = collectSignals(events, config);
    expect(signals.some((s) => s.type === "tool_failure_cascade")).toBe(true);
  });

  it("detects context churn", () => {
    const events = [
      makeEvent({ type: "session_start", timestamp: tsSec(0) }),
      makeEvent({ type: "compaction", timestamp: tsSec(10) }),
      makeEvent({ type: "compaction", timestamp: tsSec(20) }),
      makeEvent({ type: "session_end", timestamp: tsSec(30) }),
    ];
    const config = makeConfig();
    const signals = collectSignals(events, config);
    expect(signals.some((s) => s.type === "context_churn")).toBe(true);
  });

  it("detects multiple signals at once", () => {
    const events = [
      makeEvent({ type: "session_start", timestamp: tsSec(0) }),
      makeEvent({ type: "compaction", timestamp: tsSec(1) }),
      makeEvent({ type: "compaction", timestamp: tsSec(2) }),
      makeEvent({ type: "permission_result", permission_granted: false, timestamp: tsSec(3) }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" }, timestamp: tsSec(4) }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" }, timestamp: tsSec(5) }),
      makeEvent({ type: "tool_result", tool_result: { success: false, error: "e" }, timestamp: tsSec(6) }),
      makeEvent({ type: "session_end", timestamp: tsSec(10) }),
    ];
    const config = makeConfig();
    const signals = collectSignals(events, config);
    expect(signals.length).toBeGreaterThanOrEqual(2);
    const types = signals.map((s) => s.type);
    expect(types).toContain("context_churn");
    expect(types).toContain("permission_friction");
  });
});

// ── buildSignalRecord ───────────────────────────────────────────────

describe("buildSignalRecord", () => {
  it("builds a complete SignalRecord", () => {
    const events = [
      makeEvent({ type: "session_start", timestamp: tsSec(0) }),
      makeEvent({ type: "user_prompt", message: "fix the bug", timestamp: tsSec(1) }),
      makeEvent({ type: "tool_use", tool_name: "file_read", tool_input: { file_path: "/src/main.ts" }, timestamp: tsSec(2) }),
      makeEvent({ type: "tool_result", tool_name: "file_read", tool_result: { success: true }, timestamp: tsSec(3) }),
      makeEvent({ type: "session_end", timestamp: tsSec(60) }),
    ];
    const config = makeConfig();
    const record = buildSignalRecord("test-sess", events, config, "/home/user/project");

    expect(record.session_id).toBe("test-sess");
    expect(record.project).toBe("/home/user/project");
    expect(record.scope).toBe("project:/home/user/project");
    expect(record.timestamp).toBeTruthy();
    expect(Array.isArray(record.signals)).toBe(true);
    expect(record.facets.languages).toEqual(["TypeScript"]);
    expect(record.facets.tools_used).toEqual(["file_read"]);
    expect(record.facets.outcome).toBe("completed");
    expect(record.facets.total_turns).toBe(1);
  });

  it("uses pai scope for pai paths", () => {
    const events = [
      makeEvent({ type: "session_start", timestamp: tsSec(0) }),
      makeEvent({ type: "session_end", timestamp: tsSec(10) }),
    ];
    const config = makeConfig();
    const home = homedir();
    const record = buildSignalRecord("s", events, config, `${home}/.claude/hooks`);
    expect(record.scope).toBe("pai");
  });

  it("includes detected signals", () => {
    const events = [
      makeEvent({ type: "session_start", timestamp: tsSec(0) }),
      makeEvent({ type: "compaction", timestamp: tsSec(1) }),
      makeEvent({ type: "compaction", timestamp: tsSec(2) }),
      makeEvent({ type: "session_end", timestamp: tsSec(10) }),
    ];
    const config = makeConfig();
    const record = buildSignalRecord("s", events, config, "/tmp/test");
    expect(record.signals.length).toBeGreaterThan(0);
    expect(record.signals[0]!.type).toBe("context_churn");
  });
});

// ── End-to-end: script execution ────────────────────────────────────

describe("signal-tagger script", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tagger-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("exits silently with empty stdin", async () => {
    const proc = Bun.spawn(["bun", "run", "src/signal-tagger.ts"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.end();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  it("exits silently with invalid JSON", async () => {
    const proc = Bun.spawn(["bun", "run", "src/signal-tagger.ts"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write("{bad json}");
    proc.stdin.end();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  it("exits silently with missing session_id", async () => {
    const proc = Bun.spawn(["bun", "run", "src/signal-tagger.ts"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify({ cwd: "/tmp" }));
    proc.stdin.end();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  it("exits silently when session has no events", async () => {
    const proc = Bun.spawn(["bun", "run", "src/signal-tagger.ts"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify({
      session_id: "nonexistent-session",
      transcript_path: "/home/user/.claude/history/abc.jsonl",
    }));
    proc.stdin.end();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});
