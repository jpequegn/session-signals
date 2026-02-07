# Pi Coding Agent Event Format

## Overview

[pi-coding-agent](https://github.com/badlogic/pi-mono) is a minimalist AI coding agent by Mario Zechner. Sessions are stored as JSONL files with a tree-based entry structure supporting in-place branching.

## Storage Location

```
~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
```

- `<path>` — working directory with `/` replaced by `--`
- `<timestamp>` — e.g. `20260205_120000`
- `<uuid>` — session UUID (e.g. `abc-def-123`)

Configurable via `--session-dir` flag or `PI_CODING_AGENT_DIR` environment variable.

## Session File Format

Each session is a JSONL file. Each line is a JSON entry with a tree structure (id/parentId) enabling conversation branching.

### Entry Types

| Type | Description |
|------|-------------|
| `message` | User/assistant messages and tool results |
| `compaction` | Summarized context from earlier exchanges |
| `branch_summary` | Context when switching conversation branches |
| `label` | User-defined bookmarks |
| `model_change` | Model switching events |

### Message Entry Structure

```json
{
  "type": "message",
  "id": "unique-id",
  "parentId": "parent-id-or-null",
  "timestamp": "2026-02-05T10:00:00.000Z",
  "role": "user",
  "content": "fix the bug",
  "toolName": "read",
  "toolInput": { "path": "/src/main.ts" },
  "toolResult": { ... }
}
```

**User messages** have `role: "user"` with `content` (no `toolName`).

**Tool calls** have `role: "assistant"` with `toolName` and optional `toolInput`.

**Tool results** have `role: "user"` with `toolName` and either `content` (success output) or `toolResult.error` (failure).

### Tree Structure

Entries form a tree via `id`/`parentId`. The first entry has `parentId: null`. Branching creates sibling entries with the same `parentId`. The adapter follows the latest branch (last child at each node).

## Tool Name Mapping

| Pi Tool | Canonical | Description |
|---------|-----------|-------------|
| `read` | `file_read` | Read file contents |
| `write` | `file_write` | Create or overwrite files |
| `edit` | `file_edit` | Edit by exact string replacement |
| `bash` | `shell_exec` | Execute bash commands |
| `grep` | `file_search` | Search text files |
| `find` | `file_search` | Find files/directories |
| `ls` | `file_read` | List directories |

## Adapter Behavior

- **Session boundaries** are synthesized from the first and last entry timestamps.
- **Tree linearization** follows the latest branch at each fork point (last child wins).
- **Compaction entries** are mapped to the `compaction` NormalizedEvent type.
- Other entry types (`branch_summary`, `label`, `model_change`) are not mapped.

## References

- [pi-mono Repository](https://github.com/badlogic/pi-mono)
- [What I learned building pi-coding-agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- [@mariozechner/pi-coding-agent on NPM](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)
