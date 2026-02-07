import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  Config,
  PatternTrend,
  Severity,
  SignalRecord,
} from "../lib/types.js";
import type { AnalysisResult } from "../lib/pattern-analyzer.js";
import type { BeadsActionResult } from "./beads.js";

// ── Types ───────────────────────────────────────────────────────────

export interface DigestInput {
  analysisResults: AnalysisResult[];
  signalRecords: SignalRecord[];
  beadsResults?: BeadsActionResult[];
  autofixBranches?: string[];
  config: Config;
}

export interface DigestResult {
  path: string;
  markdown: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function resolveDir(dir: string): string {
  if (dir.startsWith("~/")) {
    return join(homedir(), dir.slice(2));
  }
  return dir;
}

function severityEmoji(severity: Severity): string {
  switch (severity) {
    case "high": return "🔴";
    case "medium": return "🟡";
    case "low": return "🟢";
    default: return severity satisfies never;
  }
}

function trendArrow(trend: PatternTrend): string {
  switch (trend) {
    case "increasing": return "↗️";
    case "stable": return "→";
    case "decreasing": return "↘️";
    case "new": return "🆕";
    default: return trend satisfies never;
  }
}

// ── Markdown generation ─────────────────────────────────────────────

function generateOverview(
  records: SignalRecord[],
  analysisResults: AnalysisResult[],
  autofixBranches: string[],
): string {
  const totalSessions = new Set(records.map((r) => r.session_id)).size;
  const allSignals = records.flatMap((r) => r.signals);
  const high = allSignals.filter((s) => s.severity === "high").length;
  const medium = allSignals.filter((s) => s.severity === "medium").length;
  const low = allSignals.filter((s) => s.severity === "low").length;
  const totalPatterns = analysisResults.reduce((sum, r) => sum + r.analysis.patterns.length, 0);

  const lines = [
    "## Overview",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Sessions analyzed | ${totalSessions} |`,
    `| Total signals | ${allSignals.length} |`,
    `| High severity | ${high} |`,
    `| Medium severity | ${medium} |`,
    `| Low severity | ${low} |`,
    `| Patterns identified | ${totalPatterns} |`,
    `| Auto-fix attempts | ${autofixBranches.length} |`,
    "",
  ];

  return lines.join("\n");
}

function generateFrictionPatterns(
  analysisResults: AnalysisResult[],
  beadsResults: BeadsActionResult[],
): string {
  const allPatterns = analysisResults.flatMap((r) => r.analysis.patterns);

  if (allPatterns.length === 0) {
    return "## Friction Patterns\n\nNo friction patterns detected.\n";
  }

  const beadsMap = new Map<string, BeadsActionResult>();
  for (const br of beadsResults) {
    beadsMap.set(br.pattern_id, br);
  }

  const lines = ["## Friction Patterns", ""];

  for (const pattern of allPatterns) {
    lines.push(`### ${severityEmoji(pattern.severity)} ${pattern.description}`);
    lines.push("");
    lines.push(`- **Severity:** ${pattern.severity}`);
    lines.push(`- **Frequency:** ${pattern.frequency} sessions`);
    lines.push(`- **Trend:** ${trendArrow(pattern.trend)} ${pattern.trend}`);
    lines.push(`- **Scope:** ${pattern.scope}`);

    if (pattern.root_cause_hypothesis) {
      lines.push(`- **Root cause:** ${pattern.root_cause_hypothesis}`);
    }
    if (pattern.suggested_fix) {
      lines.push(`- **Suggested fix:** ${pattern.suggested_fix}`);
    }
    if (pattern.auto_fixable) {
      lines.push(`- **Auto-fixable:** Yes`);
    }

    const beadsResult = beadsMap.get(pattern.id);
    if (beadsResult?.action === "created" || beadsResult?.action === "updated") {
      lines.push(`- **Beads issue:** ${beadsResult.issue_title ?? pattern.id}`);
    }

    if (pattern.affected_files.length > 0) {
      lines.push(`- **Affected files:** ${pattern.affected_files.join(", ")}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

function generateDelightPatterns(analysisResults: AnalysisResult[]): string {
  const allDelight = analysisResults.flatMap((r) => r.analysis.delight_patterns);

  if (allDelight.length === 0) {
    return "## Delight Patterns\n\nNo delight patterns identified.\n";
  }

  const lines = ["## Delight Patterns", ""];

  for (const dp of allDelight) {
    lines.push(`- **${dp.description}** — ${dp.insight}`);
  }

  lines.push("");
  return lines.join("\n");
}

function generateTrendTable(records: SignalRecord[], days: string[]): string {
  const lines = [
    "## 7-Day Trend Table",
    "",
    "| Date | Sessions | Signals | High | Medium | Low |",
    "|------|----------|---------|------|--------|-----|",
  ];

  for (const day of days) {
    const dayRecords = records.filter((r) => r.timestamp.slice(0, 10) === day);
    const sessions = new Set(dayRecords.map((r) => r.session_id)).size;
    const signals = dayRecords.flatMap((r) => r.signals);
    const high = signals.filter((s) => s.severity === "high").length;
    const medium = signals.filter((s) => s.severity === "medium").length;
    const low = signals.filter((s) => s.severity === "low").length;

    lines.push(`| ${day} | ${sessions} | ${signals.length} | ${high} | ${medium} | ${low} |`);
  }

  lines.push("");
  return lines.join("\n");
}

function generateConfiguration(config: Config): string {
  const lines = [
    "## Configuration",
    "",
    `| Setting | Value |`,
    `|---------|-------|`,
    `| Model | ${config.analyzer.model} |`,
    `| Lookback days | ${config.analyzer.lookback_days} |`,
    `| Min session signals | ${config.analyzer.min_session_signals} |`,
    `| Auto-fix enabled | ${config.actions.autofix.enabled} |`,
    `| Beads enabled | ${config.actions.beads.enabled} |`,
    "",
  ];

  return lines.join("\n");
}

function generateHarnessBreakdown(records: SignalRecord[]): string {
  // Group by harness from the signals' evidence — we infer from scope/project
  // Since SignalRecord doesn't carry harness info directly, group by scope
  const scopeCounts = new Map<string, { sessionIds: Set<string>; signals: number }>();

  for (const record of records) {
    const scope = record.scope;
    const existing = scopeCounts.get(scope);
    if (existing) {
      existing.sessionIds.add(record.session_id);
      existing.signals += record.signals.length;
    } else {
      scopeCounts.set(scope, { sessionIds: new Set([record.session_id]), signals: record.signals.length });
    }
  }

  if (scopeCounts.size === 0) {
    return "## Scope Breakdown\n\nNo data available.\n";
  }

  const lines = [
    "## Scope Breakdown",
    "",
    "| Scope | Sessions | Signals |",
    "|-------|----------|---------|",
  ];

  for (const [scope, counts] of [...scopeCounts.entries()].sort((a, b) => b[1].signals - a[1].signals)) {
    lines.push(`| ${scope} | ${counts.sessionIds.size} | ${counts.signals} |`);
  }

  lines.push("");
  return lines.join("\n");
}

// ── Public API ──────────────────────────────────────────────────────

export function generateDigestMarkdown(input: DigestInput, date?: Date): string {
  const {
    analysisResults,
    signalRecords,
    beadsResults = [],
    autofixBranches = [],
    config,
  } = input;

  const ref = date ?? new Date();
  const dateStr = ref.toISOString().slice(0, 10);

  // Compute 7-day range for trend table
  const days: string[] = [];
  for (let i = config.analyzer.lookback_days - 1; i >= 0; i--) {
    const d = new Date(ref);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const sections = [
    `# Session Signals Digest — ${dateStr}`,
    "",
    // Summary from analysis
    ...analysisResults
      .filter((r) => r.analysis.summary)
      .map((r) => `> ${r.analysis.summary}`),
    "",
    generateOverview(signalRecords, analysisResults, autofixBranches),
    generateFrictionPatterns(analysisResults, beadsResults),
    generateDelightPatterns(analysisResults),
    generateTrendTable(signalRecords, days),
    generateConfiguration(config),
    generateHarnessBreakdown(signalRecords),
  ];

  return sections.join("\n");
}

export async function executeDigestAction(
  input: DigestInput,
  date?: Date,
): Promise<DigestResult | null> {
  const digestConfig = input.config.actions.digest;
  if (!digestConfig.enabled) return null;

  const ref = date ?? new Date();
  const markdown = generateDigestMarkdown(input, ref);
  const dir = resolveDir(digestConfig.output_dir);
  const dateStr = ref.toISOString().slice(0, 10);
  const path = join(dir, `${dateStr}_digest.md`);

  await mkdir(dir, { recursive: true });
  await writeFile(path, markdown, "utf-8");

  return { path, markdown };
}
