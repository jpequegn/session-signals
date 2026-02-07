import { mkdir, appendFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { GeminiCliAdapter } from "../adapters/gemini-cli.js";
import { PiCodingAgentAdapter } from "../adapters/pi-coding-agent.js";
import type { HarnessAdapter } from "../adapters/types.js";
import type { Config, FrictionSignal, HarnessType, NormalizedEvent, Scope, SignalRecord } from "./types.js";
import {
  detectRephraseStorm,
  detectToolFailureCascade,
  detectContextChurn,
  detectPermissionFriction,
  detectAbandonSignal,
  detectLongStall,
  detectRetryLoop,
  extractFacets,
} from "./heuristics.js";

// ── Hook input ──────────────────────────────────────────────────────

export interface HookInput {
  session_id: string;
  cwd?: string;
  transcript_path?: string;
}

export function isHookInput(obj: unknown): obj is HookInput {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o["session_id"] === "string";
}

// ── Harness detection ───────────────────────────────────────────────

export function detectHarness(input: HookInput, config: Config): HarnessType | null {
  // If transcript_path hints at the harness, use that
  const tp = input.transcript_path ?? "";
  if (tp.includes(`${sep}.claude${sep}`)) return "claude_code";
  if (tp.includes(`${sep}.gemini${sep}`)) return "gemini_cli";
  if (tp.includes(`${sep}.pi${sep}`)) return "pi_coding_agent";

  // Check environment variables
  if (process.env["CLAUDE_CODE_SESSION"]) return "claude_code";
  if (process.env["GEMINI_SESSION"]) return "gemini_cli";
  if (process.env["PI_CODING_AGENT_DIR"]) return "pi_coding_agent";

  // Default to the first enabled harness
  for (const [key, value] of Object.entries(config.harnesses)) {
    if (value.enabled) return key as HarnessType;
  }

  return null;
}

// ── Adapter factory ─────────────────────────────────────────────────

function resolveEventsDir(dir: string): string {
  if (dir.startsWith("~/")) {
    return join(homedir(), dir.slice(2));
  }
  return dir;
}

export function createAdapter(harness: HarnessType, config: Config): HarnessAdapter | null {
  const harnessConfig = config.harnesses[harness];
  if (!harnessConfig?.enabled) return null;

  const eventsDir = resolveEventsDir(harnessConfig.events_dir);

  switch (harness) {
    case "claude_code":
      return new ClaudeCodeAdapter({ eventsDir });
    case "gemini_cli":
      return new GeminiCliAdapter({ eventsDir });
    case "pi_coding_agent":
      return new PiCodingAgentAdapter({ eventsDir });
    default:
      return null;
  }
}

// ── Scope resolution ────────────────────────────────────────────────

export function resolveScope(cwd: string, config: Config): Scope {
  const expandedPaiPaths = config.scope_rules.pai_paths.map((p) =>
    p.startsWith("~/") ? join(homedir(), p.slice(2)) : p,
  );

  for (const paiPath of expandedPaiPaths) {
    if (cwd === paiPath || cwd.startsWith(paiPath + sep)) return "pai";
  }

  return `project:${cwd}`;
}

// ── Signal collection ───────────────────────────────────────────────

export function collectSignals(events: NormalizedEvent[], config: Config): FrictionSignal[] {
  const detectors = [
    detectRephraseStorm,
    detectToolFailureCascade,
    detectContextChurn,
    detectPermissionFriction,
    detectAbandonSignal,
    detectLongStall,
    detectRetryLoop,
  ];

  const signals: FrictionSignal[] = [];
  for (const detect of detectors) {
    const signal = detect(events, config.tagger);
    if (signal) signals.push(signal);
  }
  return signals;
}

// ── Signal record construction ──────────────────────────────────────

export function buildSignalRecord(
  sessionId: string,
  events: NormalizedEvent[],
  config: Config,
  cwd: string,
): SignalRecord {
  const signals = collectSignals(events, config);
  const facets = extractFacets(events, config.tagger);
  const scope = resolveScope(cwd, config);

  return {
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    project: cwd,
    scope,
    signals,
    facets,
  };
}

// ── Output ──────────────────────────────────────────────────────────

export function signalsOutputDir(): string {
  return join(homedir(), ".claude", "history", "signals");
}

export function signalsFilePath(date?: string): string {
  const d = date ?? new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(`Invalid date format: expected YYYY-MM-DD, got "${d}"`);
  }
  return join(signalsOutputDir(), `${d}_signals.jsonl`);
}

export async function writeSignalRecord(record: SignalRecord): Promise<void> {
  const dir = signalsOutputDir();
  await mkdir(dir, { recursive: true });
  const date = record.timestamp.slice(0, 10);
  const line = JSON.stringify(record) + "\n";
  await appendFile(signalsFilePath(date), line, "utf-8");
}
