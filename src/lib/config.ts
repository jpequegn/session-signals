import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Severity } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Go up two levels to package root (works from both src/lib/ and dist/lib/),
// then into src/config.json.
const DEFAULT_CONFIG_PATH = resolve(__dirname, "..", "..", "src", "config.json");

const VALID_SEVERITIES: readonly string[] = ["high", "medium", "low"];

function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && VALID_SEVERITIES.includes(value);
}

function assertString(obj: Record<string, unknown>, key: string, path: string): void {
  if (typeof obj[key] !== "string") {
    throw new Error(`config.${path}.${key} must be a string`);
  }
}

function assertNumber(obj: Record<string, unknown>, key: string, path: string): void {
  if (typeof obj[key] !== "number") {
    throw new Error(`config.${path}.${key} must be a number`);
  }
}

function assertPositiveNumber(obj: Record<string, unknown>, key: string, path: string): void {
  assertNumber(obj, key, path);
  if ((obj[key] as number) <= 0) {
    throw new Error(`config.${path}.${key} must be positive`);
  }
}

function assertUnitInterval(obj: Record<string, unknown>, key: string, path: string): void {
  assertNumber(obj, key, path);
  const v = obj[key] as number;
  if (v < 0 || v > 1) {
    throw new Error(`config.${path}.${key} must be between 0 and 1`);
  }
}

function assertBoolean(obj: Record<string, unknown>, key: string, path: string): void {
  if (typeof obj[key] !== "boolean") {
    throw new Error(`config.${path}.${key} must be a boolean`);
  }
}

function assertStringArray(obj: Record<string, unknown>, key: string, path: string): void {
  const val = obj[key];
  if (!Array.isArray(val) || !val.every((v) => typeof v === "string")) {
    throw new Error(`config.${path}.${key} must be a string array`);
  }
}

function assertSeverity(obj: Record<string, unknown>, key: string, path: string): void {
  if (!isSeverity(obj[key])) {
    throw new Error(`config.${path}.${key} must be one of: ${VALID_SEVERITIES.join(", ")}`);
  }
}

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`config.${path} must be an object`);
  }
}

function validateTagger(tagger: unknown): void {
  assertObject(tagger, "tagger");
  const t = tagger as Record<string, unknown>;
  assertPositiveNumber(t, "rephrase_threshold", "tagger");
  assertUnitInterval(t, "rephrase_similarity", "tagger");
  assertPositiveNumber(t, "tool_failure_cascade_min", "tagger");
  assertPositiveNumber(t, "context_churn_threshold", "tagger");
  assertPositiveNumber(t, "abandon_window_seconds", "tagger");
  assertPositiveNumber(t, "stall_threshold_seconds", "tagger");
  assertPositiveNumber(t, "retry_loop_min", "tagger");
  assertUnitInterval(t, "retry_similarity", "tagger");
}

function validateAnalyzer(analyzer: unknown): void {
  assertObject(analyzer, "analyzer");
  const a = analyzer as Record<string, unknown>;
  assertString(a, "model", "analyzer");
  assertString(a, "ollama_url", "analyzer");
  assertPositiveNumber(a, "lookback_days", "analyzer");
  assertPositiveNumber(a, "min_session_signals", "analyzer");
}

function validateActions(actions: unknown): void {
  assertObject(actions, "actions");
  const a = actions as Record<string, unknown>;

  assertObject(a["beads"], "actions.beads");
  const beads = a["beads"] as Record<string, unknown>;
  assertBoolean(beads, "enabled", "actions.beads");
  assertSeverity(beads, "min_severity", "actions.beads");
  assertPositiveNumber(beads, "min_frequency", "actions.beads");
  assertString(beads, "title_prefix", "actions.beads");

  assertObject(a["digest"], "actions.digest");
  const digest = a["digest"] as Record<string, unknown>;
  assertBoolean(digest, "enabled", "actions.digest");
  assertString(digest, "output_dir", "actions.digest");

  assertObject(a["autofix"], "actions.autofix");
  const autofix = a["autofix"] as Record<string, unknown>;
  assertBoolean(autofix, "enabled", "actions.autofix");
  assertSeverity(autofix, "min_severity", "actions.autofix");
  assertPositiveNumber(autofix, "min_frequency", "actions.autofix");
  assertString(autofix, "branch_prefix", "actions.autofix");
  assertPositiveNumber(autofix, "branch_ttl_days", "actions.autofix");
  assertStringArray(autofix, "allowed_tools", "actions.autofix");
}

function validateHarnesses(harnesses: unknown): void {
  assertObject(harnesses, "harnesses");
  const h = harnesses as Record<string, unknown>;

  for (const key of Object.keys(h)) {
    assertObject(h[key], `harnesses.${key}`);
    const entry = h[key] as Record<string, unknown>;
    assertBoolean(entry, "enabled", `harnesses.${key}`);
    assertString(entry, "events_dir", `harnesses.${key}`);
  }
}

function validateScopeRules(scopeRules: unknown): void {
  assertObject(scopeRules, "scope_rules");
  const s = scopeRules as Record<string, unknown>;
  assertStringArray(s, "pai_paths", "scope_rules");
  assertStringArray(s, "ignore_paths", "scope_rules");
}

function validateConfig(raw: unknown): Config {
  assertObject(raw, "");
  const obj = raw as Record<string, unknown>;
  assertString(obj, "version", "");
  validateTagger(obj["tagger"]);
  validateAnalyzer(obj["analyzer"]);
  validateActions(obj["actions"]);
  validateHarnesses(obj["harnesses"]);
  validateScopeRules(obj["scope_rules"]);
  return raw as unknown as Config;
}

/**
 * Load and validate configuration from a JSON file.
 * Defaults to the bundled src/config.json.
 */
export async function loadConfig(path?: string): Promise<Config> {
  const configPath = path ?? DEFAULT_CONFIG_PATH;
  const raw = await readFile(configPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  return validateConfig(parsed);
}
