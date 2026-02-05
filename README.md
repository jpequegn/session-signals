# session-signals

Self-improving friction detection for AI coding agents.

Analyzes session data from multiple coding harnesses (Claude Code, Gemini CLI, pi-coding-agent) to detect friction patterns, surface trends via daily digests, auto-file issues, and attempt fixes on branches.

Inspired by [Factory Signals](https://factory.ai/news/factory-signals).

## Architecture

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

## Status

**Pre-alpha** — See [design document](docs/plans/2026-02-05-claude-signals-design.md) for full architecture.

## License

MIT
