# session-signals

Self-improving friction detection for AI coding agents.

Analyzes session data from multiple coding harnesses (Claude Code, Gemini CLI, pi-coding-agent) to detect friction patterns, surface trends via daily digests, auto-file issues, and attempt fixes on branches.

Inspired by [Factory Signals](https://factory.ai/news/factory-signals).

## How It Works

Session-signals runs in two tiers:

1. **Real-time signal tagger** — fires on every Claude Code `SessionEnd` hook, runs 7 friction heuristics in <1s, appends a signal record to a daily JSONL file.
2. **Daily batch analyzer** — runs at midnight via launchd, reads the last 7 days of signal records, uses Ollama (local LLM) to identify patterns, then generates a markdown digest, files issues via [beads](https://github.com/jpequegn/beads), and optionally spawns headless auto-fix branches.

```
┌────────────────────────────────────────────────────────┐
│                  Harness Adapters                       │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐    │
│  │ Claude   │  │ Gemini   │  │ pi-coding-agent   │    │
│  │ Code     │  │ CLI      │  │                   │    │
│  └────┬─────┘  └────┬─────┘  └────────┬──────────┘    │
│       └──────────────┴────────────────┘                │
│                      │                                 │
│            Normalized Event Stream                     │
└──────────────────────┬─────────────────────────────────┘
                       │
         ┌─────────────┴──────────────┐
         ▼                            ▼
  ┌─────────────┐            ┌──────────────┐
  │ Signal      │            │ Pattern      │
  │ Tagger      │            │ Analyzer     │
  │ (real-time) │            │ (daily batch)│
  └──────┬──────┘            └──────┬───────┘
         │                          │
         └──────────┬───────────────┘
                    ▼
           ┌───────────────┐
           │ Action Engine │
           │ Issues/Digest │
           │ Auto-fix PRs  │
           └───────────────┘
```

## Prerequisites

- [Bun](https://bun.sh) (runtime and test runner)
- [Ollama](https://ollama.com) (local LLM for pattern analysis — optional for signal tagging)
- macOS (launchd scheduling; the core library works anywhere Bun runs)

## Quick Start

```bash
# Clone and install
git clone https://github.com/jpequegn/session-signals.git
cd session-signals
bun install

# Run the install script (sets up hooks + launchd)
./scripts/install.sh

# Verify
bun test
```

The install script:
1. Checks that `bun` is available (warns if `ollama` is missing)
2. Creates `~/.claude/signals/` and `~/.claude/history/signals/digests/`
3. Symlinks the signal tagger to `~/.claude/signals/signal-tagger.ts`
4. Registers a `SessionEnd` hook in `~/.claude/settings.json`
5. Installs a launchd plist to run the pattern analyzer at midnight

After install, every Claude Code session will automatically generate friction signals. The daily batch runs at midnight to analyze trends.

## Manual Usage

### Run the signal tagger manually

The signal tagger reads a hook input from stdin:

```bash
echo '{"session_id":"your-session-id"}' | bun src/signal-tagger.ts
```

Signal records are appended to `~/.claude/history/signals/YYYY-MM-DD_signals.jsonl`.

### Run the pattern analyzer manually

```bash
bun src/pattern-analyzer.ts
```

This reads the last 7 days of signal records, calls Ollama to identify patterns, and prints the analysis as JSON to stdout. Requires Ollama running with a model pulled (default: `llama3.2`):

```bash
ollama pull llama3.2
ollama serve  # in another terminal
bun src/pattern-analyzer.ts
```

### Run tests

```bash
bun test
```

436 tests across 13 test files, covering all components and integration.

### Type check

```bash
bun run typecheck
```

### Build (compile TypeScript)

```bash
bun run build
```

Output goes to `dist/`.

## Friction Signals Detected

The signal tagger runs 7 heuristic detectors on every session:

| Signal | Severity | What It Detects |
|--------|----------|-----------------|
| `rephrase_storm` | medium/high | User rephrasing the same request 3+ times (Levenshtein similarity > 0.6) |
| `tool_failure_cascade` | medium/high | 3+ consecutive tool failures |
| `context_churn` | medium | 2+ compaction events in a single session |
| `permission_friction` | low/medium | Permission requests denied by the user |
| `abandon_signal` | high | Session ended without completion within 120s of last prompt |
| `long_stall` | medium | Gap of 60+ seconds between consecutive events |
| `retry_loop` | medium/high | 3+ tool uses with similar inputs (Levenshtein similarity > 0.7) |

All thresholds are configurable in `config.json` under the `tagger` section.

## Actions

### Daily Digest

Generates a markdown report at `~/.claude/history/signals/digests/YYYY-MM-DD_digest.md` containing:
- Overview stats (sessions, signals by severity, patterns found)
- Friction patterns with severity, trend, root cause, and suggested fix
- Delight patterns (things working well)
- 7-day trend table
- Scope breakdown

### Beads Integration

Automatically files issues for recurring friction patterns using the [beads](https://github.com/jpequegn/beads) issue tracker:
- Creates new issues when a pattern first exceeds thresholds
- Updates existing issues with trend comments on subsequent runs
- Skips patterns below `min_severity` (default: medium) or `min_frequency` (default: 2)

Requires the `bd` CLI to be installed and a beads project initialized.

### Auto-Fix Spawner

For patterns marked `auto_fixable` by the LLM analysis:
- Creates a git branch (`signals/fix-{pattern-id}`)
- Spawns a headless `claude -p` session with a focused fix prompt
- Never merges — branches are for human review
- Enforces a daily limit of 3 auto-fixes
- Skips if the git working tree is dirty
- Cleans up branches older than `branch_ttl_days` (default: 14)

## Configuration

All settings live in `config.json` at the project root. The config is validated at load time.

### Tagger thresholds

```json
{
  "tagger": {
    "rephrase_threshold": 3,
    "rephrase_similarity": 0.6,
    "tool_failure_cascade_min": 3,
    "context_churn_threshold": 2,
    "abandon_window_seconds": 120,
    "stall_threshold_seconds": 60,
    "retry_loop_min": 3,
    "retry_similarity": 0.7
  }
}
```

### Analyzer settings

```json
{
  "analyzer": {
    "model": "llama3.2",
    "ollama_url": "http://localhost:11434",
    "lookback_days": 7,
    "min_session_signals": 1
  }
}
```

### Actions

```json
{
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
      "allowed_tools": ["file_edit", "file_write"]
    }
  }
}
```

### Harnesses

Enable/disable adapters and set their events directories:

```json
{
  "harnesses": {
    "claude_code": {
      "enabled": true,
      "events_dir": "~/.claude/history/raw-outputs"
    },
    "gemini_cli": {
      "enabled": false,
      "events_dir": ""
    },
    "pi_coding_agent": {
      "enabled": false,
      "events_dir": ""
    }
  }
}
```

### Scope rules

Control which paths are treated as "PAI" (personal AI infrastructure) scope vs project scope:

```json
{
  "scope_rules": {
    "pai_paths": ["~/.claude"],
    "ignore_paths": ["node_modules", ".git", "dist", "build"]
  }
}
```

## Data Flow

```
Session ends
    → SessionEnd hook fires
    → signal-tagger.ts reads stdin (hook input JSON)
    → Detects harness type (Claude Code, Gemini, etc.)
    → Adapter parses raw events → NormalizedEvent[]
    → 7 heuristic detectors run → FrictionSignal[]
    → Builds SignalRecord with facets (languages, tools, outcome)
    → Appends to ~/.claude/history/signals/YYYY-MM-DD_signals.jsonl

Midnight (launchd)
    → pattern-analyzer.ts runs
    → Loads last 7 days of signal records
    → Groups by scope (project path)
    → Computes daily trends per signal type
    → Sends structured prompt to Ollama → PatternAnalysis
    → Action engine:
        → Generates digest markdown
        → Files/updates beads issues
        → Spawns auto-fix branches (if applicable)
```

## File Locations

| What | Where |
|------|-------|
| Signal records | `~/.claude/history/signals/YYYY-MM-DD_signals.jsonl` |
| Daily digests | `~/.claude/history/signals/digests/YYYY-MM-DD_digest.md` |
| Signal tagger (symlink) | `~/.claude/signals/signal-tagger.ts` |
| Claude Code hook | `~/.claude/settings.json` → `hooks.SessionEnd` |
| launchd plist | `~/Library/LaunchAgents/com.session-signals.daily-analysis.plist` |
| Config | `config.json` (project root) |
| Logs | `/tmp/session-signals.log`, `/tmp/session-signals-error.log` |

## Uninstalling

```bash
./scripts/uninstall.sh
```

This removes the hook, symlink, and launchd plist. Signal history data is preserved. To also delete data:

```bash
./scripts/uninstall.sh --purge
```

## Project Structure

```
src/
  signal-tagger.ts          # Entry point: SessionEnd hook handler
  pattern-analyzer.ts       # Entry point: daily batch analyzer
  index.ts                  # Barrel exports
  adapters/
    types.ts                # HarnessAdapter interface
    claude-code.ts          # Claude Code JSONL adapter
    gemini-cli.ts           # Gemini CLI adapter
    pi-coding-agent.ts      # Pi Coding Agent adapter
  lib/
    types.ts                # All core types
    config.ts               # Config loader + validator
    heuristics.ts           # 7 friction detectors + facet extraction
    tagger.ts               # Signal tagger pipeline
    ollama-client.ts        # Ollama HTTP client with retry
    pattern-analyzer.ts     # Batch analysis pipeline
  actions/
    beads.ts                # Beads issue tracker integration
    digest.ts               # Daily digest generator
    autofix.ts              # Auto-fix branch spawner
scripts/
  install.sh                # Idempotent installer
  uninstall.sh              # Clean uninstaller
tests/
  fixtures/                 # JSONL test fixtures
  integration/              # End-to-end pipeline tests
  *.test.ts                 # Unit tests (one per module)
config.json                 # Default configuration
```

## License

MIT
