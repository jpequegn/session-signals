import type {
  NormalizedEvent,
  FrictionSignal,
  Severity,
  SessionFacets,
  SessionOutcome,
  TaggerConfig,
} from "./types.js";

// ── String similarity ───────────────────────────────────────────────

/** Compute Levenshtein distance between two strings. */
function levenshteinDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  // Use single-row optimization
  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);

  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,      // deletion
        curr[j - 1]! + 1,  // insertion
        prev[j - 1]! + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[lb]!;
}

/** Compute similarity ratio (0–1) between two strings. 1 = identical. */
export function levenshteinRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

// ── Helpers ─────────────────────────────────────────────────────────

function timeDiffSeconds(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return NaN;
  return (tb - ta) / 1000;
}

function severityFromCount(count: number, lowThreshold: number, highThreshold: number): Severity {
  if (count >= highThreshold) return "high";
  if (count >= lowThreshold) return "medium";
  return "low";
}

// ── Friction detectors ──────────────────────────────────────────────

/**
 * Detect rephrase storm: user rephrases similar prompts multiple times.
 * Note: only compares adjacent prompt pairs, so interleaved rephrases
 * (e.g. A → B → A) are not detected.
 */
export function detectRephraseStorm(
  events: NormalizedEvent[],
  config: TaggerConfig,
): FrictionSignal | null {
  const prompts = events
    .map((e, i) => ({ event: e, index: i }))
    .filter((x) => x.event.type === "user_prompt" && x.event.message);

  if (prompts.length < 2) return null;

  let rephraseCount = 0;
  const indices: number[] = [];
  const samples: string[] = [];

  for (let i = 1; i < prompts.length; i++) {
    const prev = prompts[i - 1]!;
    const curr = prompts[i]!;
    const ratio = levenshteinRatio(prev.event.message!, curr.event.message!);

    if (ratio >= config.rephrase_similarity) {
      rephraseCount++;
      if (indices.length === 0) indices.push(prev.index);
      indices.push(curr.index);
      if (samples.length < 3) samples.push(curr.event.message!);
    }
  }

  if (rephraseCount < config.rephrase_threshold) return null;

  return {
    type: "rephrase_storm",
    severity: severityFromCount(rephraseCount, config.rephrase_threshold, config.rephrase_threshold * 2),
    count: rephraseCount,
    context: `User rephrased ${rephraseCount} times with similarity >= ${config.rephrase_similarity}`,
    evidence: {
      event_indices: indices,
      sample_data: samples.join(" | "),
    },
  };
}

/**
 * Detect tool failure cascade: consecutive tool failures.
 */
export function detectToolFailureCascade(
  events: NormalizedEvent[],
  config: TaggerConfig,
): FrictionSignal | null {
  let maxStreak = 0;
  let currentStreak = 0;
  let streakIndices: number[] = [];
  let bestIndices: number[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.type !== "tool_result") continue;

    if (event.tool_result?.success === false) {
      currentStreak++;
      streakIndices.push(i);
      if (currentStreak > maxStreak) {
        maxStreak = currentStreak;
        bestIndices = [...streakIndices];
      }
    } else {
      currentStreak = 0;
      streakIndices = [];
    }
  }

  if (maxStreak < config.tool_failure_cascade_min) return null;

  const failedTools = bestIndices.map((i) => events[i]!.tool_name).filter(Boolean);

  return {
    type: "tool_failure_cascade",
    severity: severityFromCount(maxStreak, config.tool_failure_cascade_min, config.tool_failure_cascade_min * 2),
    count: maxStreak,
    context: `${maxStreak} consecutive tool failures`,
    evidence: {
      event_indices: bestIndices,
      sample_data: failedTools.join(", "),
    },
  };
}

/**
 * Detect context churn: excessive compaction events.
 */
export function detectContextChurn(
  events: NormalizedEvent[],
  config: TaggerConfig,
): FrictionSignal | null {
  const compactions = events
    .map((e, i) => ({ index: i, event: e }))
    .filter((x) => x.event.type === "compaction");

  if (compactions.length < config.context_churn_threshold) return null;

  return {
    type: "context_churn",
    severity: severityFromCount(compactions.length, config.context_churn_threshold, config.context_churn_threshold * 2),
    count: compactions.length,
    context: `${compactions.length} context compaction events in session`,
    evidence: {
      event_indices: compactions.map((c) => c.index),
    },
  };
}

/**
 * Detect permission friction: permission denied then retried.
 */
export function detectPermissionFriction(
  events: NormalizedEvent[],
  _config: TaggerConfig,
): FrictionSignal | null {
  const permEvents = events
    .map((e, i) => ({ index: i, event: e }))
    .filter((x) => x.event.type === "permission_result");

  let denials = 0;
  const indices: number[] = [];

  for (const pe of permEvents) {
    if (pe.event.permission_granted === false) {
      denials++;
      indices.push(pe.index);
    }
  }

  if (denials === 0) return null;

  return {
    type: "permission_friction",
    severity: severityFromCount(denials, 1, 3),
    count: denials,
    context: `${denials} permission denial(s) in session`,
    evidence: {
      event_indices: indices,
    },
  };
}

/**
 * Detect abandon signal: session ended shortly after failures without resolution.
 */
export function detectAbandonSignal(
  events: NormalizedEvent[],
  config: TaggerConfig,
): FrictionSignal | null {
  // Find last session_end
  let endIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "session_end") {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) return null;

  const endTs = events[endIndex]!.timestamp;

  // Look for failures within the abandon window before session end
  const failures: number[] = [];
  for (let i = endIndex - 1; i >= 0; i--) {
    const event = events[i]!;
    const gap = timeDiffSeconds(event.timestamp, endTs);
    if (Number.isNaN(gap)) continue;
    if (gap > config.abandon_window_seconds) break;

    if (event.type === "tool_result" && event.tool_result?.success === false) {
      failures.push(i);
    }
  }

  if (failures.length === 0) return null;

  // Check if there was any success after the failures
  const lastFailure = Math.max(...failures);
  const hasSuccessAfter = events.slice(lastFailure + 1, endIndex).some(
    (e) => e.type === "tool_result" && e.tool_result?.success === true,
  );

  if (hasSuccessAfter) return null;

  return {
    type: "abandon_signal",
    severity: severityFromCount(failures.length, 1, 3),
    count: failures.length,
    context: `Session ended within ${config.abandon_window_seconds}s of ${failures.length} unresolved failure(s)`,
    evidence: {
      event_indices: [...failures, endIndex],
    },
  };
}

/**
 * Detect long stall: large time gaps between consecutive events.
 */
export function detectLongStall(
  events: NormalizedEvent[],
  config: TaggerConfig,
): FrictionSignal | null {
  let stalls = 0;
  const indices: number[] = [];

  for (let i = 1; i < events.length; i++) {
    const gap = timeDiffSeconds(events[i - 1]!.timestamp, events[i]!.timestamp);
    if (Number.isNaN(gap)) continue;
    if (gap >= config.stall_threshold_seconds) {
      stalls++;
      indices.push(i - 1, i);
    }
  }

  if (stalls === 0) return null;

  return {
    type: "long_stall",
    severity: severityFromCount(stalls, 1, 3),
    count: stalls,
    context: `${stalls} stall(s) exceeding ${config.stall_threshold_seconds}s`,
    evidence: {
      event_indices: [...new Set(indices)],
    },
  };
}

/**
 * Detect retry loop: same command executed repeatedly.
 */
export function detectRetryLoop(
  events: NormalizedEvent[],
  config: TaggerConfig,
): FrictionSignal | null {
  const toolUses = events
    .map((e, i) => ({ index: i, event: e }))
    .filter((x) => x.event.type === "tool_use" && x.event.tool_input);

  if (toolUses.length < 2) return null;

  let maxStreak = 0;
  let currentStreak = 1;
  let streakIndices: number[] = [];
  let bestIndices: number[] = [];

  for (let i = 1; i < toolUses.length; i++) {
    const prev = toolUses[i - 1]!;
    const curr = toolUses[i]!;

    const prevInput = JSON.stringify(prev.event.tool_input);
    const currInput = JSON.stringify(curr.event.tool_input);
    const ratio = levenshteinRatio(prevInput, currInput);

    if (prev.event.tool_name === curr.event.tool_name && ratio >= config.retry_similarity) {
      if (currentStreak === 1) streakIndices = [prev.index];
      currentStreak++;
      streakIndices.push(curr.index);
      if (currentStreak > maxStreak) {
        maxStreak = currentStreak;
        bestIndices = [...streakIndices];
      }
    } else {
      currentStreak = 1;
      streakIndices = [];
    }
  }

  if (maxStreak < config.retry_loop_min) return null;

  return {
    type: "retry_loop",
    severity: severityFromCount(maxStreak, config.retry_loop_min, config.retry_loop_min * 2),
    count: maxStreak,
    context: `Same tool executed ${maxStreak} times with similarity >= ${config.retry_similarity}`,
    evidence: {
      event_indices: bestIndices,
    },
  };
}

// ── Facet extraction ────────────────────────────────────────────────

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript",
  py: "Python", pyw: "Python",
  rb: "Ruby", erb: "Ruby",
  rs: "Rust",
  go: "Go",
  java: "Java",
  kt: "Kotlin", kts: "Kotlin",
  swift: "Swift",
  cs: "C#",
  cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++", hxx: "C++",
  // .h is ambiguous (could be C, C++, or Objective-C); defaulting to C
  c: "C", h: "C",
  php: "PHP",
  scala: "Scala",
  sh: "Shell", bash: "Shell", zsh: "Shell",
  sql: "SQL",
  html: "HTML", htm: "HTML",
  css: "CSS", scss: "CSS", sass: "CSS", less: "CSS",
  json: "JSON",
  yaml: "YAML", yml: "YAML",
  md: "Markdown",
  xml: "XML",
  toml: "TOML",
};

/** Infer programming languages from file paths in tool events. */
export function inferLanguages(events: NormalizedEvent[]): string[] {
  const languages = new Set<string>();

  for (const event of events) {
    if (event.type !== "tool_use" && event.type !== "tool_result") continue;
    const input = event.tool_input;
    if (!input) continue;

    // Look for file paths in common input keys
    for (const key of ["file_path", "path", "target_file", "filePath"]) {
      const val = input[key];
      if (typeof val !== "string") continue;
      const ext = val.split(".").pop()?.toLowerCase();
      if (ext) {
        const lang = EXTENSION_TO_LANGUAGE[ext];
        if (lang) languages.add(lang);
      }
    }
  }

  return [...languages].sort();
}

/** Classify session outcome from events. */
export function classifyOutcome(events: NormalizedEvent[], config: TaggerConfig): SessionOutcome {
  let lastEnd: NormalizedEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "session_end") {
      lastEnd = events[i]!;
      break;
    }
  }
  if (!lastEnd) return "abandoned";

  // Check for abandon signal
  const abandonSignal = detectAbandonSignal(events, config);
  if (abandonSignal) return "abandoned";

  // Check for high tool failure rate at end
  const lastResults = events.filter((e) => e.type === "tool_result").slice(-3);
  const allFailed = lastResults.length > 0 && lastResults.every((e) => e.tool_result?.success === false);
  if (allFailed) return "errored";

  return "completed";
}

/** Extract session facets from an event stream. */
export function extractFacets(events: NormalizedEvent[], config: TaggerConfig): SessionFacets {
  const toolResults = events.filter((e) => e.type === "tool_result");
  const failedResults = toolResults.filter((e) => e.tool_result?.success === false);
  const toolNames = new Set<string>();
  for (const e of events) {
    if (e.tool_name) toolNames.add(e.tool_name);
  }

  const timestamps = events.map((e) => Date.parse(e.timestamp)).filter((t) => !Number.isNaN(t));
  const durationMs = timestamps.length >= 2
    ? Math.max(...timestamps) - Math.min(...timestamps)
    : 0;

  return {
    languages: inferLanguages(events),
    tools_used: [...toolNames].sort(),
    tool_failure_rate: toolResults.length > 0 ? failedResults.length / toolResults.length : 0,
    session_duration_min: durationMs / 60_000,
    total_turns: events.filter((e) => e.type === "user_prompt").length,
    outcome: classifyOutcome(events, config),
  };
}
