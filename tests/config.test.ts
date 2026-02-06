import { describe, it, expect } from "bun:test";
import { loadConfig } from "../src/lib/config.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, rm } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = resolve(__dirname, "..", "src", "config.json");

describe("loadConfig", () => {
  it("loads and validates the default config.json", async () => {
    const config = await loadConfig(DEFAULT_CONFIG);
    expect(config.version).toBe("1.0.0");
    expect(config.tagger.rephrase_threshold).toBe(3);
    expect(config.tagger.rephrase_similarity).toBe(0.6);
    expect(config.analyzer.model).toBe("llama3.2");
    expect(config.analyzer.ollama_url).toBe("http://localhost:11434");
    expect(config.actions.beads.enabled).toBe(true);
    expect(config.actions.beads.min_severity).toBe("medium");
    expect(config.actions.digest.output_dir).toBe("~/.claude/history/signals/digests");
    expect(config.actions.autofix.branch_prefix).toBe("signals/fix-");
    expect(config.harnesses.claude_code.enabled).toBe(true);
    expect(config.harnesses.gemini_cli.enabled).toBe(false);
    expect(config.scope_rules.pai_paths).toEqual(["~/.claude"]);
    expect(config.scope_rules.ignore_paths).toContain("node_modules");
  });

  it("rejects config with missing tagger section", async () => {
    const bad = resolve(__dirname, "bad-config.json");
    await writeFile(bad, JSON.stringify({ version: "1.0.0" }));
    try {
      await expect(loadConfig(bad)).rejects.toThrow("config.tagger must be an object");
    } finally {
      await rm(bad, { force: true });
    }
  });

  it("rejects config with invalid severity", async () => {
    const bad = resolve(__dirname, "bad-severity.json");
    const config = {
      version: "1.0.0",
      tagger: {
        rephrase_threshold: 3, rephrase_similarity: 0.6,
        tool_failure_cascade_min: 3, context_churn_threshold: 2,
        abandon_window_seconds: 120, stall_threshold_seconds: 60,
        retry_loop_min: 3, retry_similarity: 0.7,
      },
      analyzer: { model: "llama3.2", ollama_url: "http://localhost:11434", lookback_days: 7, min_session_signals: 1 },
      actions: {
        beads: { enabled: true, min_severity: "invalid", min_frequency: 2, title_prefix: "[signals]" },
        digest: { enabled: true, output_dir: "out" },
        autofix: { enabled: true, min_severity: "high", min_frequency: 3, branch_prefix: "fix-", branch_ttl_days: 14, allowed_tools: [] },
      },
      harnesses: {
        claude_code: { enabled: true, events_dir: "" },
        gemini_cli: { enabled: false, events_dir: "" },
        pi_coding_agent: { enabled: false, events_dir: "" },
      },
      scope_rules: { pai_paths: [], ignore_paths: [] },
    };
    await writeFile(bad, JSON.stringify(config));
    try {
      await expect(loadConfig(bad)).rejects.toThrow("must be one of: high, medium, low");
    } finally {
      await rm(bad, { force: true });
    }
  });

  it("rejects config with negative retry_loop_min", async () => {
    const bad = resolve(__dirname, "bad-negative.json");
    const config = {
      version: "1.0.0",
      tagger: {
        rephrase_threshold: 3, rephrase_similarity: 0.6,
        tool_failure_cascade_min: 3, context_churn_threshold: 2,
        abandon_window_seconds: 120, stall_threshold_seconds: 60,
        retry_loop_min: -1, retry_similarity: 0.7,
      },
      analyzer: { model: "llama3.2", ollama_url: "http://localhost:11434", lookback_days: 7, min_session_signals: 1 },
      actions: {
        beads: { enabled: true, min_severity: "medium", min_frequency: 2, title_prefix: "[signals]" },
        digest: { enabled: true, output_dir: "out" },
        autofix: { enabled: true, min_severity: "high", min_frequency: 3, branch_prefix: "fix-", branch_ttl_days: 14, allowed_tools: [] },
      },
      harnesses: { claude_code: { enabled: true, events_dir: "" } },
      scope_rules: { pai_paths: [], ignore_paths: [] },
    };
    await writeFile(bad, JSON.stringify(config));
    try {
      await expect(loadConfig(bad)).rejects.toThrow("must be non-negative");
    } finally {
      await rm(bad, { force: true });
    }
  });

  it("rejects config with similarity out of (0,1) range", async () => {
    const bad = resolve(__dirname, "bad-similarity.json");
    const config = {
      version: "1.0.0",
      tagger: {
        rephrase_threshold: 3, rephrase_similarity: 1.5,
        tool_failure_cascade_min: 3, context_churn_threshold: 2,
        abandon_window_seconds: 120, stall_threshold_seconds: 60,
        retry_loop_min: 3, retry_similarity: 0.7,
      },
      analyzer: { model: "llama3.2", ollama_url: "http://localhost:11434", lookback_days: 7, min_session_signals: 1 },
      actions: {
        beads: { enabled: true, min_severity: "medium", min_frequency: 2, title_prefix: "[signals]" },
        digest: { enabled: true, output_dir: "out" },
        autofix: { enabled: true, min_severity: "high", min_frequency: 3, branch_prefix: "fix-", branch_ttl_days: 14, allowed_tools: [] },
      },
      harnesses: { claude_code: { enabled: true, events_dir: "" } },
      scope_rules: { pai_paths: [], ignore_paths: [] },
    };
    await writeFile(bad, JSON.stringify(config));
    try {
      await expect(loadConfig(bad)).rejects.toThrow("must be between 0 and 1 exclusive");
    } finally {
      await rm(bad, { force: true });
    }
  });

  it("rejects config with similarity of exactly 0", async () => {
    const bad = resolve(__dirname, "bad-similarity-zero.json");
    const config = {
      version: "1.0.0",
      tagger: {
        rephrase_threshold: 3, rephrase_similarity: 0.0,
        tool_failure_cascade_min: 3, context_churn_threshold: 2,
        abandon_window_seconds: 120, stall_threshold_seconds: 60,
        retry_loop_min: 3, retry_similarity: 0.7,
      },
      analyzer: { model: "llama3.2", ollama_url: "http://localhost:11434", lookback_days: 7, min_session_signals: 1 },
      actions: {
        beads: { enabled: true, min_severity: "medium", min_frequency: 2, title_prefix: "[signals]" },
        digest: { enabled: true, output_dir: "out" },
        autofix: { enabled: true, min_severity: "high", min_frequency: 3, branch_prefix: "fix-", branch_ttl_days: 14, allowed_tools: [] },
      },
      harnesses: { claude_code: { enabled: true, events_dir: "" } },
      scope_rules: { pai_paths: [], ignore_paths: [] },
    };
    await writeFile(bad, JSON.stringify(config));
    try {
      await expect(loadConfig(bad)).rejects.toThrow("must be between 0 and 1 exclusive");
    } finally {
      await rm(bad, { force: true });
    }
  });

  it("accepts config with zero for count fields", async () => {
    const good = resolve(__dirname, "zero-counts.json");
    const config = {
      version: "1.0.0",
      tagger: {
        rephrase_threshold: 0, rephrase_similarity: 0.6,
        tool_failure_cascade_min: 0, context_churn_threshold: 0,
        abandon_window_seconds: 120, stall_threshold_seconds: 60,
        retry_loop_min: 0, retry_similarity: 0.7,
      },
      analyzer: { model: "llama3.2", ollama_url: "http://localhost:11434", lookback_days: 7, min_session_signals: 0 },
      actions: {
        beads: { enabled: true, min_severity: "medium", min_frequency: 0, title_prefix: "[signals]" },
        digest: { enabled: true, output_dir: "out" },
        autofix: { enabled: true, min_severity: "high", min_frequency: 0, branch_prefix: "fix-", branch_ttl_days: 14, allowed_tools: [] },
      },
      harnesses: { claude_code: { enabled: true, events_dir: "" } },
      scope_rules: { pai_paths: [], ignore_paths: [] },
    };
    await writeFile(good, JSON.stringify(config));
    try {
      const loaded = await loadConfig(good);
      expect(loaded.tagger.retry_loop_min).toBe(0);
    } finally {
      await rm(good, { force: true });
    }
  });

  it("rejects non-existent config file", async () => {
    await expect(loadConfig("/nonexistent/config.json")).rejects.toThrow();
  });
});
