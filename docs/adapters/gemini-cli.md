# Gemini CLI Event Format

## Storage Location

Gemini CLI stores sessions at:

```
~/.gemini/tmp/<project_hash>/chats/session-<timestamp>-<short_id>.json
```

- `<project_hash>` — derived from the project root path
- `<timestamp>` — e.g. `2025-09-18T02-45`
- `<short_id>` — first 8 hex chars of the session UUID (e.g. `3b44bc68`)

The adapter uses the full filename stem (e.g. `session-2025-09-18T02-45-3b44bc68`) as the session ID to avoid collision risk from the short hex suffix alone.

Other files in the same directory (`checkpoint-*.json`, `logs.json`, `shell_history`) are ignored by the adapter.

## Session File Format

Each session is a JSON file with a `history` array of `Content` objects following the Gemini API's Content/Part model:

```json
{
  "history": [
    {
      "role": "user",
      "parts": [{ "text": "help me fix this bug" }]
    },
    {
      "role": "model",
      "parts": [{ "functionCall": { "name": "read_file", "args": { "target_file": "/src/main.ts" } } }]
    },
    {
      "role": "user",
      "parts": [{ "functionResponse": { "name": "read_file", "response": { "name": "read_file", "content": "file contents..." } } }]
    },
    {
      "role": "model",
      "parts": [{ "text": "The file contains..." }]
    }
  ]
}
```

### Part Types

| Part Type | Description |
|-----------|-------------|
| `{ text: string }` | Plain text (user prompt or model response) |
| `{ functionCall: { name, args } }` | Model requests tool execution |
| `{ functionResponse: { name, response } }` | Tool execution result returned to model |

### Error Detection

A `functionResponse` with `response.content.error` indicates a failed tool call:

```json
{
  "functionResponse": {
    "name": "run_shell_command",
    "response": { "name": "run_shell_command", "content": { "error": "command not found" } }
  }
}
```

## Tool Name Mapping

| Gemini CLI | Canonical | Category |
|------------|-----------|----------|
| `run_shell_command` | `shell_exec` | Execute |
| `write_file` | `file_write` | Edit |
| `replace` | `file_edit` | Edit |
| `read_file` | `file_read` | Read |
| `list_directory` | `file_read` | Read |
| `glob` | `file_search` | Search |
| `search_file_content` | `file_search` | Search |
| `grep_search` | `file_search` | Search |
| `web_fetch` | `web_access` | Fetch |
| `google_web_search` | `web_access` | Fetch |
| `save_memory` | `memory` | Think |
| `write_todos` | `planning` | Plan |
| `codebase_investigator` | `file_search` | Search |
| `activate_skill` | `skill` | Other |

## Adapter Behavior

- **Session boundaries** are synthesized (session_start at the beginning, session_end at the end) since Gemini CLI session files represent complete sessions.
- **Timestamps** are derived from the session filename. Individual events within a session get incrementally offset timestamps to preserve ordering.
- **Model text responses** are not mapped to NormalizedEvents (only user prompts, tool calls, and tool results are captured).
- **Multiple tool calls** in a single model turn produce separate `tool_use` events.

## References

- [Gemini CLI Repository](https://github.com/google-gemini/gemini-cli)
- [Session Management Docs](https://geminicli.com/docs/cli/session-management/)
- [JSONL Migration Proposal (Issue #15292)](https://github.com/google-gemini/gemini-cli/issues/15292)
