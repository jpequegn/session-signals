import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  Config,
  PatternAnalysis,
  PatternTrend,
  Scope,
  SignalRecord,
} from "./types.js";
import type { OllamaClient } from "./ollama-client.js";
import { signalsOutputDir } from "./tagger.js";

// ── Signal loading ──────────────────────────────────────────────────

export function dateRange(lookbackDays: number, referenceDate?: Date): string[] {
  const ref = referenceDate ?? new Date();
  const dates: string[] = [];
  for (let i = 0; i < lookbackDays; i++) {
    const d = new Date(ref);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates.reverse();
}

export async function loadSignalRecords(
  days: string[],
  dir?: string,
): Promise<SignalRecord[]> {
  const signalsDir = dir ?? signalsOutputDir();
  const records: SignalRecord[] = [];

  let files: string[];
  try {
    files = await readdir(signalsDir);
  } catch {
    return records;
  }

  const daySet = new Set(days);
  const matching = files.filter((f) => {
    const date = f.replace(/_signals\.jsonl$/, "");
    return daySet.has(date);
  });

  for (const file of matching) {
    let content: string;
    try {
      content = await readFile(join(signalsDir, file), "utf-8");
    } catch {
      continue;
    }

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as SignalRecord;
        if (record.session_id && record.scope) {
          records.push(record);
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  return records;
}

// ── Grouping ────────────────────────────────────────────────────────

export function groupByScope(records: SignalRecord[]): Map<Scope, SignalRecord[]> {
  const groups = new Map<Scope, SignalRecord[]>();
  for (const record of records) {
    const existing = groups.get(record.scope);
    if (existing) {
      existing.push(record);
    } else {
      groups.set(record.scope, [record]);
    }
  }
  return groups;
}

// ── Trend computation ───────────────────────────────────────────────

export interface DailyTrend {
  date: string;
  counts: Record<string, number>;
}

export function computeDailyTrends(
  records: SignalRecord[],
  days: string[],
): DailyTrend[] {
  const dayMap = new Map<string, Record<string, number>>();
  for (const day of days) {
    dayMap.set(day, {});
  }

  for (const record of records) {
    const date = record.timestamp.slice(0, 10);
    const counts = dayMap.get(date);
    if (!counts) continue;

    for (const signal of record.signals) {
      counts[signal.type] = (counts[signal.type] ?? 0) + signal.count;
    }
  }

  return days.map((date) => ({
    date,
    counts: dayMap.get(date) ?? {},
  }));
}

export function classifyTrend(
  signalType: string,
  trends: DailyTrend[],
): PatternTrend {
  const counts = trends.map((t) => t.counts[signalType] ?? 0);
  const activeDays = counts.filter((c) => c > 0).length;

  if (activeDays === 0) return "new";

  // Check if it only appeared in the most recent day
  const nonZeroIndices = counts
    .map((c, i) => (c > 0 ? i : -1))
    .filter((i) => i >= 0);
  if (nonZeroIndices.length === 1 && nonZeroIndices[0] === counts.length - 1) {
    return "new";
  }

  if (activeDays < 3) return "new";

  // Compare first half vs second half
  const mid = Math.floor(counts.length / 2);
  const firstHalf = counts.slice(0, mid).reduce((a, b) => a + b, 0);
  const secondHalf = counts.slice(mid).reduce((a, b) => a + b, 0);

  if (secondHalf > firstHalf * 1.2) return "increasing";
  if (secondHalf < firstHalf * 0.8) return "decreasing";
  return "stable";
}

// ── Prompt building ─────────────────────────────────────────────────

export function buildPrompt(
  scope: Scope,
  records: SignalRecord[],
  trends: DailyTrend[],
): string {
  const signalSummary = records.flatMap((r) =>
    r.signals.map((s) => ({
      session_id: r.session_id,
      type: s.type,
      severity: s.severity,
      count: s.count,
      context: s.context,
    })),
  );

  const trendTable = trends.map((t) => {
    const entries = Object.entries(t.counts)
      .map(([type, count]) => `${type}=${count}`)
      .join(", ");
    return `${t.date}: ${entries || "(none)"}`;
  });

  // Collect unique signal types for trend classification
  const signalTypes = new Set<string>();
  for (const record of records) {
    for (const signal of record.signals) {
      signalTypes.add(signal.type);
    }
  }

  const trendClassifications: Record<string, PatternTrend> = {};
  for (const type of signalTypes) {
    trendClassifications[type] = classifyTrend(type, trends);
  }

  return `You are a coding agent friction analyst. Analyze these signals from scope "${scope}" and produce a structured JSON response.

## Signals (${signalSummary.length} total from ${records.length} sessions)

${JSON.stringify(signalSummary, null, 2)}

## Daily Trend Table (last ${trends.length} days)

${trendTable.join("\n")}

## Pre-computed Trend Classifications

${JSON.stringify(trendClassifications, null, 2)}

## Instructions

Produce a JSON object matching this exact schema:

{
  "patterns": [
    {
      "id": "pat-YYYYMMDD-NNN",
      "type": "recurring_friction" | "new_friction" | "regression",
      "scope": "${scope}",
      "description": "...",
      "severity": "high" | "medium" | "low",
      "frequency": <number of sessions affected>,
      "trend": "increasing" | "stable" | "decreasing" | "new",
      "root_cause_hypothesis": "...",
      "suggested_fix": "...",
      "auto_fixable": true | false,
      "fix_scope": "pai" | "project",
      "affected_files": ["..."]
    }
  ],
  "delight_patterns": [
    {
      "description": "...",
      "insight": "..."
    }
  ],
  "summary": "Brief overall summary of friction patterns"
}

Rules:
- Group related signals into patterns (e.g. repeated tool_failure_cascade on the same tool)
- Use the pre-computed trend classifications
- Set auto_fixable=true only for patterns that could be fixed by modifying config or CLAUDE.md
- Include delight_patterns for things that work well (low failure rates, fast sessions)
- Keep the summary under 200 words
- Return ONLY valid JSON, no markdown fences or extra text`;
}

// ── Analysis execution ──────────────────────────────────────────────

export interface AnalysisResult {
  scope: Scope;
  analysis: PatternAnalysis;
  skipped: boolean;
}

const EMPTY_ANALYSIS: PatternAnalysis = {
  patterns: [],
  delight_patterns: [],
  summary: "",
};

function isPatternAnalysis(obj: unknown): obj is PatternAnalysis {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return Array.isArray(o["patterns"]) && typeof o["summary"] === "string";
}

export async function analyzeScope(
  scope: Scope,
  records: SignalRecord[],
  trends: DailyTrend[],
  client: OllamaClient,
  config: Config,
  warn?: (msg: string) => void,
): Promise<AnalysisResult> {
  // Filter records with signals meeting minimum threshold
  const withSignals = records.filter((r) => r.signals.length >= config.analyzer.min_session_signals);
  if (withSignals.length === 0) {
    return { scope, analysis: EMPTY_ANALYSIS, skipped: true };
  }

  const available = await client.isAvailable();
  if (!available) {
    warn?.("Ollama is not available, skipping pattern analysis");
    return { scope, analysis: EMPTY_ANALYSIS, skipped: true };
  }

  const prompt = buildPrompt(scope, withSignals, trends);

  try {
    const result = await client.generateJSON<PatternAnalysis>(prompt, {
      model: config.analyzer.model,
    });

    if (!isPatternAnalysis(result)) {
      warn?.(`Ollama returned unexpected shape for scope "${scope}"`);
      return { scope, analysis: EMPTY_ANALYSIS, skipped: true };
    }

    return { scope, analysis: result, skipped: false };
  } catch (err) {
    warn?.(`Pattern analysis failed for scope "${scope}": ${err}`);
    return { scope, analysis: EMPTY_ANALYSIS, skipped: true };
  }
}

export async function runAnalysis(
  config: Config,
  client: OllamaClient,
  options?: {
    signalsDir?: string;
    referenceDate?: Date;
    warn?: (msg: string) => void;
  },
): Promise<AnalysisResult[]> {
  const days = dateRange(config.analyzer.lookback_days, options?.referenceDate);
  const records = await loadSignalRecords(days, options?.signalsDir);

  if (records.length === 0) {
    return [];
  }

  const groups = groupByScope(records);
  const results: AnalysisResult[] = [];

  for (const [scope, scopeRecords] of groups) {
    const trends = computeDailyTrends(scopeRecords, days);
    const result = await analyzeScope(scope, scopeRecords, trends, client, config, options?.warn);
    results.push(result);
  }

  return results;
}
