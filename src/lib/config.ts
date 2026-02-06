import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Severity } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Go up two levels to package root (works from both src/lib/ and dist/lib/).
const DEFAULT_CONFIG_PATH = resolve(__dirname, "..", "..", "config.json");

const SUPPORTED_VERSIONS: readonly string[] = ["1.0.0"];
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

function assertNonNegativeNumber(obj: Record<string, unknown>, key: string, path: string): void {
  assertNumber(obj, key, path);
  if ((obj[key] as number) < 0) {
    throw new Error(`config.${path}.${key} must be non-negative`);
  }
}

function assertExclusiveUnitInterval(obj: Record<string, unknown>, key: string, path: string): void {
  assertNumber(obj, key, path);
  const v = obj[key] as number;
  if (v <= 0 || v >= 1) {
    throw new Error(`config.${path}.${key} must be between 0 and 1 exclusive`);
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

function warnExtraneousKeys(obj: Record<string, unknown>, expected: readonly string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!expected.includes(key)) {
      console.warn(`config warning: unexpected key "${key}" in ${path || "root"}`);
    }
  }
}

const TAGGER_KEYS = ["rephrase_threshold", "rephrase_similarity", "tool_failure_cascade_min", "context_churn_threshold", "abandon_window_seconds", "stall_threshold_seconds", "retry_loop_min", "retry_similarity"] as const;

function validateTagger(tagger: unknown): void {
  assertObject(tagger, "tagger");
  const t = tagger as Record<string, unknown>;
  warnExtraneousKeys(t, TAGGER_KEYS, "tagger");
  assertNonNegativeNumber(t, "rephrase_threshold", "tagger");
  assertExclusiveUnitInterval(t, "rephrase_similarity", "tagger");
  assertNonNegativeNumber(t, "tool_failure_cascade_min", "tagger");
  assertNonNegativeNumber(t, "context_churn_threshold", "tagger");
  assertPositiveNumber(t, "abandon_window_seconds", "tagger");
  assertPositiveNumber(t, "stall_threshold_seconds", "tagger");
  assertNonNegativeNumber(t, "retry_loop_min", "tagger");
  assertExclusiveUnitInterval(t, "retry_similarity", "tagger");
}

const ANALYZER_KEYS = ["model", "ollama_url", "lookback_days", "min_session_signals"] as const;

function validateAnalyzer(analyzer: unknown): void {
  assertObject(analyzer, "analyzer");
  const a = analyzer as Record<string, unknown>;
  warnExtraneousKeys(a, ANALYZER_KEYS, "analyzer");
  assertString(a, "model", "analyzer");
  assertString(a, "ollama_url", "analyzer");
  assertPositiveNumber(a, "lookback_days", "analyzer");
  assertNonNegativeNumber(a, "min_session_signals", "analyzer");
}

const ACTIONS_KEYS = ["beads", "digest", "autofix"] as const;
const BEADS_KEYS = ["enabled", "min_severity", "min_frequency", "title_prefix"] as const;
const DIGEST_KEYS = ["enabled", "output_dir"] as const;
const AUTOFIX_KEYS = ["enabled", "min_severity", "min_frequency", "branch_prefix", "branch_ttl_days", "allowed_tools"] as const;

function validateActions(actions: unknown): void {
  assertObject(actions, "actions");
  const a = actions as Record<string, unknown>;
  warnExtraneousKeys(a, ACTIONS_KEYS, "actions");

  assertObject(a["beads"], "actions.beads");
  const beads = a["beads"] as Record<string, unknown>;
  warnExtraneousKeys(beads, BEADS_KEYS, "actions.beads");
  assertBoolean(beads, "enabled", "actions.beads");
  assertSeverity(beads, "min_severity", "actions.beads");
  assertNonNegativeNumber(beads, "min_frequency", "actions.beads");
  assertString(beads, "title_prefix", "actions.beads");

  assertObject(a["digest"], "actions.digest");
  const digest = a["digest"] as Record<string, unknown>;
  warnExtraneousKeys(digest, DIGEST_KEYS, "actions.digest");
  assertBoolean(digest, "enabled", "actions.digest");
  assertString(digest, "output_dir", "actions.digest");

  assertObject(a["autofix"], "actions.autofix");
  const autofix = a["autofix"] as Record<string, unknown>;
  warnExtraneousKeys(autofix, AUTOFIX_KEYS, "actions.autofix");
  assertBoolean(autofix, "enabled", "actions.autofix");
  assertSeverity(autofix, "min_severity", "actions.autofix");
  assertNonNegativeNumber(autofix, "min_frequency", "actions.autofix");
  assertString(autofix, "branch_prefix", "actions.autofix");
  assertPositiveNumber(autofix, "branch_ttl_days", "actions.autofix");
  assertStringArray(autofix, "allowed_tools", "actions.autofix");
}

const HARNESS_ENTRY_KEYS = ["enabled", "events_dir"] as const;

function validateHarnesses(harnesses: unknown): void {
  assertObject(harnesses, "harnesses");
  const h = harnesses as Record<string, unknown>;

  for (const key of Object.keys(h)) {
    assertObject(h[key], `harnesses.${key}`);
    const entry = h[key] as Record<string, unknown>;
    warnExtraneousKeys(entry, HARNESS_ENTRY_KEYS, `harnesses.${key}`);
    assertBoolean(entry, "enabled", `harnesses.${key}`);
    assertString(entry, "events_dir", `harnesses.${key}`);
  }
}

const SCOPE_RULES_KEYS = ["pai_paths", "ignore_paths"] as const;

function validateScopeRules(scopeRules: unknown): void {
  assertObject(scopeRules, "scope_rules");
  const s = scopeRules as Record<string, unknown>;
  warnExtraneousKeys(s, SCOPE_RULES_KEYS, "scope_rules");
  assertStringArray(s, "pai_paths", "scope_rules");
  assertStringArray(s, "ignore_paths", "scope_rules");
}

const CONFIG_KEYS = ["version", "tagger", "analyzer", "actions", "harnesses", "scope_rules"] as const;

function validateConfig(raw: unknown): Config {
  assertObject(raw, "");
  const obj = raw as Record<string, unknown>;
  warnExtraneousKeys(obj, CONFIG_KEYS, "");
  assertString(obj, "version", "");
  const version = obj["version"] as string;
  if (!SUPPORTED_VERSIONS.includes(version)) {
    throw new Error(`config version "${version}" is not supported (expected one of: ${SUPPORTED_VERSIONS.join(", ")})`);
  }
  validateTagger(obj["tagger"]);
  validateAnalyzer(obj["analyzer"]);
  validateActions(obj["actions"]);
  validateHarnesses(obj["harnesses"]);
  validateScopeRules(obj["scope_rules"]);
  return raw as unknown as Config;
}

/**
 * Load and validate configuration from a JSON file.
 * Defaults to the bundled config.json at the package root.
 */
export async function loadConfig(path?: string): Promise<Config> {
  const configPath = path ?? DEFAULT_CONFIG_PATH;
  const raw = await readFile(configPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  return validateConfig(parsed);
}
