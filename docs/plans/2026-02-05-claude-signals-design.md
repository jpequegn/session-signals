# Claude Signals - Design Document

**Date:** 2026-02-05
**Status:** Draft
**Author:** Lucien + Julien

---

## 1. Problem Statement

Claude Code sessions generate rich behavioral data through hooks, but this data is write-only — captured and stored, never analyzed. Friction patterns repeat across sessions: users rephrase prompts, tools fail in cascades, permission dialogs interrupt flow. These patterns are invisible without systematic analysis.

Factory.ai's "Factory Signals" demonstrates that an AI coding agent can analyze its own session data to detect friction, create tickets, and auto-resolve ~73% of issues with <4hr turnaround. This design adapts that architecture to Claude Code using the existing PAI hooks infrastructure.

---

## 2. Goals

1. **Detect friction automatically** — identify where sessions go wrong using heuristic signal tagging
2. **Surface patterns over time** — use Ollama to find recurring issues across sessions and projects
3. **Create actionable tickets** — auto-file Beads issues for patterns exceeding severity thresholds
4. **Generate daily digests** — human-readable trend reports for review
5. **Attempt auto-fixes** — spawn Claude Code on branches to fix detected issues, never auto-merge

### Non-Goals (v1)

- Real-time intervention during sessions (future: PreToolUse hooks that warn about known friction patterns)
- Dashboard or web UI (the daily digest markdown is sufficient for v1)
- Multi-user support (single-user PAI system)

---

## 3. Architecture

### 3.1 System Overview

```
                        REAL-TIME TIER                    BATCH TIER
                        ─────────────                     ──────────
Session Events          SessionEnd Hook                   Daily Cron (midnight)
     │                       │                                  │
     ▼                       ▼                                  ▼
┌──────────┐          ┌─────────────┐                   ┌──────────────┐
│ Existing │          │ Signal      │                   │ Pattern      │
│ capture- │─────────▶│ Tagger      │──── signals.jsonl │ Analyzer     │
│ all-     │          │ (no LLM)    │    (tagged data)  │ (Ollama)     │
│ events.ts│          └─────────────┘                   └──────┬───────┘
└──────────┘           Adds: rephrase                          │
                       count, tool fail                        ▼
                       rate, churn score,              ┌───────────────┐
                       session outcome                 │ Action Engine │
                                                       │ - Beads issue │
                                                       │ - Daily digest│
                                                       │ - Auto-fix PR │
                                                       └───────────────┘
```

### 3.2 Two-Tier Processing

| Tier | Trigger | Engine | Latency | Cost |
|------|---------|--------|---------|------|
| **Real-time** | SessionEnd hook | Pure heuristics (no LLM) | <1s | Zero |
| **Batch** | Daily cron (midnight) | Ollama llama3.2 | <30s | Zero |

### 3.3 Scope Routing

Every signal is tagged with a scope derived from the session's `cwd`:

| Path Pattern | Scope | Improvement Target |
|-------------|-------|-------------------|
| `~/.claude/` | `pai` | PAI infrastructure (hooks, skills, CLAUDE.md, settings) |
| Any other path | `project:<path>` | That specific project's code |

---

## 4. Component Design

### 4.1 Signal Tagger (`signal-tagger.ts`)

**Hook:** SessionEnd
**Runtime:** Bun
**LLM:** None — pure heuristics
**Input:** Reads `~/.claude/history/raw-outputs/YYYY-MM/YYYY-MM-DD_all-events.jsonl`, filtered to the ending session's `session_id`
**Output:** Appends to `~/.claude/history/signals/YYYY-MM-DD_signals.jsonl`

#### Friction Signals

| Signal | Detection Heuristic | Severity |
|--------|-------------------|----------|
| `rephrase_storm` | 3+ UserPromptSubmit with Levenshtein ratio >0.6 within 5 consecutive turns | High |
| `tool_failure_cascade` | 3+ consecutive PostToolUseFailure for the same tool_name | High |
| `context_churn` | PreCompact triggered >2x in one session | Medium |
| `permission_friction` | Same PermissionRequest denied then re-attempted (same tool_name + similar input) | Medium |
| `abandon_signal` | SessionEnd occurs <2min after the last PostToolUseFailure | High |
| `long_stall` | >60s gap between a UserPromptSubmit timestamp and the next PreToolUse timestamp | Low |
| `retry_loop` | Same Bash command executed 3+ times with Levenshtein ratio >0.7 between commands | Medium |

#### Facet Extraction

Computed from the session's events without LLM:

```typescript
interface SessionFacets {
  languages: string[];        // Derived from file extensions in Edit/Write/Read tool_input.file_path
  tools_used: string[];       // Unique tool_name values from PreToolUse events
  tool_failure_rate: number;  // PostToolUseFailure count / total PostToolUse count
  session_duration_min: number; // Last event timestamp - first event timestamp
  total_turns: number;        // Count of UserPromptSubmit events
  outcome: 'completed' | 'abandoned' | 'errored'; // Based on SessionEnd reason + abandon_signal
}
```

#### Output Schema

```typescript
interface SignalRecord {
  session_id: string;
  timestamp: string;              // ISO 8601
  project: string;                // cwd from session events
  scope: 'pai' | `project:${string}`;
  signals: FrictionSignal[];
  facets: SessionFacets;
}

interface FrictionSignal {
  type: string;                   // Signal name from table above
  severity: 'high' | 'medium' | 'low';
  count: number;                  // How many times this signal fired
  context: string;                // Human-readable description of what happened
  evidence: {                     // Raw data supporting the signal
    event_indices: number[];      // Indices into the session's event stream
    sample_data?: string;         // E.g., the rephrased prompts or failed commands
  };
}
```

### 4.2 Pattern Analyzer (`pattern-analyzer.ts`)

**Trigger:** Daily via launchd plist (midnight local time)
**Runtime:** Bun
**LLM:** Ollama llama3.2 via HTTP API (localhost:11434)
**Input:** `~/.claude/history/signals/YYYY-MM-DD_signals.jsonl` for last 7 days
**Output:** Pattern analysis JSON passed to Action Engine

#### Processing Pipeline

```
1. Load signals from last 7 days
2. Group by scope (pai vs each unique project path)
3. For each group:
   a. Build context window: all signals + facets for that scope
   b. Include 7-day trend data (signal counts per day)
   c. Send to Ollama with structured output prompt
   d. Parse response
4. Pass all patterns to Action Engine
```

#### Ollama Prompt Template

```
You are a coding agent behavior analyst. Analyze these session friction signals
and identify recurring patterns that can be fixed.

SCOPE: {scope}
SIGNALS FROM LAST 7 DAYS:
{signals_json}

DAILY SIGNAL COUNTS:
{trend_table}

Respond with JSON only. Schema:
{
  "patterns": [
    {
      "id": "pat-YYYYMMDD-NNN",
      "type": "recurring_friction" | "new_friction" | "regression",
      "scope": "{scope}",
      "description": "Clear description of the pattern",
      "severity": "high" | "medium" | "low",
      "frequency": <number of sessions affected>,
      "trend": "increasing" | "stable" | "decreasing" | "new",
      "root_cause_hypothesis": "What likely causes this",
      "suggested_fix": "Specific actionable fix",
      "auto_fixable": true | false,
      "fix_scope": "pai" | "project",
      "affected_files": ["list of files to change if known"]
    }
  ],
  "delight_patterns": [
    {
      "description": "What works well",
      "insight": "Why it works and how to preserve it"
    }
  ],
  "summary": "One-paragraph summary of the day"
}
```

#### Trend Classification

| Condition | Trend |
|-----------|-------|
| Pattern appears in 3+ of last 7 days and count is rising | `increasing` |
| Pattern appears in 3+ of last 7 days, count is flat | `stable` |
| Pattern appeared before but count is dropping | `decreasing` |
| First occurrence in 7-day window | `new` |

### 4.3 Action Engine (`action-engine.ts`)

**Trigger:** Called by Pattern Analyzer after analysis completes
**Runtime:** Bun
**Three outputs:** Beads issues, daily digest, auto-fix branches

#### 4.3a Beads Issue Creation

**Threshold:** `severity >= medium` AND `frequency >= 2`

```bash
bd create \
  --title="[signals] ${pattern.description}" \
  --type=bug \
  --priority=${priority_map[pattern.severity]}
```

Priority mapping:
- `high` → `1` (P1)
- `medium` → `2` (P2)
- `low` → `3` (P3)

**Deduplication:** Before creating, run `bd search` for open issues with `[signals]` prefix. If a match is found (fuzzy title match), add a comment to the existing issue with updated frequency/trend data instead of creating a duplicate.

**Label:** All auto-created issues prefixed with `[signals]` in the title for easy filtering.

#### 4.3b Daily Digest

**Output:** `~/.claude/history/signals/digests/YYYY-MM-DD_digest.md`

```markdown
# Signals Digest - YYYY-MM-DD

## Overview
- **Sessions analyzed:** {count}
- **Friction signals detected:** {total} ({high} high, {medium} medium, {low} low)
- **Patterns identified:** {pattern_count}
- **Auto-fix attempts:** {autofix_count}

## Friction Patterns

### [HIGH] {pattern.description}
- **Frequency:** {n} sessions, trend: {trend}
- **Root cause:** {hypothesis}
- **Suggested fix:** {fix}
- **Beads:** {issue_id} ({created|updated|existing})
- **Auto-fix:** {branch_name|not attempted}

### [MEDIUM] {pattern.description}
...

## Delight Patterns
- {delight.description} — {delight.insight}

## 7-Day Trend

| Day | Sessions | Signals | High | Med | Low | Auto-Fixed |
|-----|----------|---------|------|-----|-----|------------|
| {day} | {n} | {n} | {n} | {n} | {n} | {n} |
| ... |

## Configuration
- Model: {ollama_model}
- Thresholds: severity >= {min_severity}, frequency >= {min_frequency}
- Auto-fix: {enabled|disabled}

---
*Generated by claude-signals at {timestamp}*
```

#### 4.3c Auto-Fix Spawner

**Threshold:** `auto_fixable: true` AND `severity == "high"` AND `frequency >= 3`

Conservative threshold — only attempts fixes for well-understood, recurring high-severity patterns.

**Execution:**

```bash
# Navigate to the correct directory based on scope
cd ${scope === 'pai' ? '~/.claude' : scope.replace('project:', '')}

# Create fix branch
git checkout -b signals/fix-${pattern.id}

# Spawn headless Claude Code
claude -p "$(cat <<EOF
You are fixing a friction pattern detected by claude-signals.

Pattern: ${pattern.description}
Root cause: ${pattern.root_cause_hypothesis}
Suggested fix: ${pattern.suggested_fix}
Affected files: ${pattern.affected_files.join(', ')}
Scope: ${pattern.fix_scope}

Instructions:
1. Read the affected files first
2. Implement the suggested fix
3. Keep changes minimal and focused
4. Commit with message: "[signals] Fix: ${pattern.description}"

Do NOT merge to main. Commit to this branch and stop.
EOF
)" --allowedTools Edit,Write,Read,Bash,Grep,Glob
```

**Human gate:** Fixes stay on branches. The daily digest lists all fix branches for manual review. No auto-merge, ever.

**Cleanup:** Fix branches older than 14 days without merge are auto-deleted by the daily cron with a warning in the digest.

---

## 5. File Structure

```
~/.claude/
├── signals/                          # NEW: All claude-signals code
│   ├── signal-tagger.ts              # SessionEnd hook script
│   ├── pattern-analyzer.ts           # Daily cron entry point
│   ├── action-engine.ts              # Beads + digest + auto-fix
│   ├── lib/
│   │   ├── types.ts                  # Shared TypeScript interfaces
│   │   ├── heuristics.ts             # Friction detection functions
│   │   └── ollama-client.ts          # Thin HTTP wrapper for Ollama API
│   └── config.json                   # Tunable thresholds and settings
├── history/
│   └── signals/                      # NEW: Signal data output
│       ├── YYYY-MM-DD_signals.jsonl  # Tagged signals (written by tagger)
│       └── digests/
│           └── YYYY-MM-DD_digest.md  # Daily digests (written by analyzer)
└── settings.json                     # MODIFIED: Add SessionEnd hook entry
```

### Changes to Existing Files

| File | Change | Risk |
|------|--------|------|
| `~/.claude/settings.json` | Add one SessionEnd hook entry for `signal-tagger.ts` | Minimal — additive only, existing hooks unaffected |

No other existing files are modified.

---

## 6. Configuration

`~/.claude/signals/config.json`:

```json
{
  "version": "1.0.0",

  "tagger": {
    "rephrase_threshold": 3,
    "rephrase_similarity": 0.6,
    "tool_failure_cascade_min": 3,
    "context_churn_threshold": 2,
    "abandon_window_seconds": 120,
    "stall_threshold_seconds": 60,
    "retry_loop_min": 3,
    "retry_similarity": 0.7
  },

  "analyzer": {
    "model": "llama3.2",
    "ollama_url": "http://localhost:11434",
    "lookback_days": 7,
    "min_session_signals": 0
  },

  "actions": {
    "beads": {
      "enabled": true,
      "min_severity": "medium",
      "min_frequency": 2,
      "title_prefix": "[signals]"
    },
    "digest": {
      "enabled": true,
      "output_dir": "~/.claude/history/signals/digests"
    },
    "autofix": {
      "enabled": true,
      "min_severity": "high",
      "min_frequency": 3,
      "branch_prefix": "signals/fix-",
      "branch_ttl_days": 14,
      "allowed_tools": ["Edit", "Write", "Read", "Bash", "Grep", "Glob"]
    }
  },

  "scope_rules": {
    "pai_paths": ["~/.claude"],
    "ignore_paths": ["node_modules", ".git", "dist", "build"]
  }
}
```

---

## 7. Implementation Plan

| Step | Component | Description | Depends On | Estimated Complexity |
|------|-----------|-------------|-----------|---------------------|
| 1 | `lib/types.ts` | Shared interfaces: SignalRecord, FrictionSignal, SessionFacets, PatternAnalysis, Config | None | Low |
| 2 | `config.json` | Default configuration with tunable thresholds | None | Low |
| 3 | `lib/heuristics.ts` | 7 friction detection functions, facet extraction, Levenshtein utility | Step 1 | Medium |
| 4 | `signal-tagger.ts` | SessionEnd hook: reads events, runs heuristics, writes signals.jsonl | Steps 1-3 | Medium |
| 5 | Hook registration | Add SessionEnd entry to `~/.claude/settings.json` | Step 4 | Low |
| 6 | `lib/ollama-client.ts` | HTTP client for Ollama: send prompt, parse JSON response, retry logic | Step 1 | Low |
| 7 | `pattern-analyzer.ts` | Daily batch: load signals, group by scope, call Ollama, parse patterns | Steps 1, 6 | Medium |
| 8 | `action-engine.ts` | Beads integration, digest generator, auto-fix spawner | Steps 1, 7 | Medium-High |
| 9 | `launchd` plist | Schedule daily cron at midnight for pattern-analyzer | Step 8 | Low |
| 10 | Integration testing | End-to-end: fake signals → analyzer → digest + beads issue | Steps 4-9 | Medium |

### Steps 1-2 can run in parallel. Steps 3-4 are sequential. Steps 6-7 can run in parallel with 3-4. Step 8 depends on both tracks. Step 9-10 are final.

---

## 8. Testing Strategy

### Unit Tests
- Each heuristic function in `heuristics.ts` tested with fixture JSONL data
- Ollama client tested with mock HTTP responses
- Action engine tested with mock Beads CLI and mock Claude Code CLI

### Integration Tests
- Synthetic `all-events.jsonl` with known friction patterns → verify signal tagger output
- Synthetic `signals.jsonl` → verify pattern analyzer groups correctly and produces valid prompts
- Full pipeline: synthetic events → tagger → analyzer (real Ollama) → verify digest content

### Manual Validation
- Run 5 real sessions with intentional friction (rephrase, retry, abandon)
- Verify signals are tagged correctly
- Review first digest for accuracy

---

## 9. Future Enhancements (Out of Scope for v1)

| Enhancement | Description |
|-------------|-------------|
| **Real-time warnings** | PreToolUse hook that checks if current action matches a known friction pattern and injects a warning into Claude's context |
| **Embedding-based clustering** | Replace Levenshtein with sentence embeddings for better rephrase detection (needs embedding model in Ollama) |
| **Dashboard** | Web UI for browsing friction trends, built on existing agent-observability infrastructure |
| **Cross-project patterns** | Detect friction patterns that appear across multiple projects (e.g., "always struggles with Docker") |
| **Claude API upgrade** | Replace Ollama with Claude Sonnet for deeper reasoning when API access is available |
| **Session replay** | Link from digest patterns to transcript excerpts showing the friction in context |
| **Feedback loop metrics** | Track auto-fix acceptance rate, time-to-merge, regression rate |

---

## 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Ollama not running at cron time | Batch analysis skipped | Retry 3x with backoff; log to digest as "skipped" |
| False positive friction signals | Noise in Beads | Conservative thresholds; `min_frequency >= 2` filter; `[signals]` prefix for easy cleanup |
| Auto-fix introduces bugs | Code regression | Branch-only policy; never auto-merge; 14-day TTL cleanup |
| Signal tagger slows SessionEnd | UX degradation | No LLM in tagger; pure heuristics; <1s target; async if needed |
| Large signal files over time | Disk usage | Monthly rotation: signals older than 90 days archived to `signals/archive/` |

---

## 11. Success Criteria

| Metric | Target |
|--------|--------|
| Signal tagger latency | <1 second per SessionEnd |
| False positive rate | <30% of created Beads issues are irrelevant |
| Pattern detection | Catches known friction within 3 sessions |
| Auto-fix acceptance rate | >50% of fix branches merged within 7 days |
| Daily digest usefulness | User reads it at least 3x/week in first month |

---

## 12. Decision Log

| Decision | Rationale | Alternatives Considered |
|----------|-----------|----------------------|
| Ollama over Claude API | Zero cost; Max subscription doesn't cover programmatic API calls; sufficient for structured extraction | Claude API (cost), Claude Code headless (clunky for batch) |
| Heuristics over LLM for tagging | Speed (<1s), zero cost, deterministic, no external dependency at session time | LLM-based tagging (slow, costly, overkill for pattern matching) |
| Beads over Linear | Already integrated in PAI workflow; `bd` CLI available; dependency tracking built-in | Linear (requires API setup, separate system) |
| Branch-only auto-fix | Safety: human must review before merge; prevents regressions | Auto-merge with tests (too risky for v1) |
| Levenshtein for similarity | Simple, fast, no dependencies; sufficient for detecting prompt rephrasing and command retries | Cosine similarity with embeddings (overkill for v1) |
| Daily batch over real-time analysis | Matches Factory's architecture; Ollama analysis is more accurate with full day context; lower resource usage | Per-session analysis (higher compute, less context for trends) |
