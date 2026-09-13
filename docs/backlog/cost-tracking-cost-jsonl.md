# Cost tracking for summarization — `cost.jsonl`

**Status:** parked (2026-09-02, user decision)

Log the cost of every handoff summarization as one JSONL line, appended to:

```
$PI_CODING_AGENT_DIR/data/pi-handoff/cost.jsonl
```

Parsed later offline to measure actual benefits (of serializeConversation
optimization, model choices, etc.).

### Record sketch

```jsonc
{
  "ts": "2026-09-02T12:34:56.789Z",
  "sessionFile": "/path/to/session.jsonl",   // parent session
  "cwd": "/path/to/project",
  "modelProvider": "anthropic",
  "modelId": "claude-...",
  "effort": "high",                           // thinking level | undefined
  "modelSource": "settings" | "fallback-active",
  "outcome": "ok" | "error" | "aborted",
  "error": "only on outcome=error",
  "conversationChars": 481233,                // serialized transcript size
  "outputChars": 4211,
  "durationMs": 18432,
  "usage": {                                  // from streamSimple result, when available
    "inputTokens": 123456,
    "outputTokens": 987,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0
  }
}
```

### Requirements

- Fire-and-forget append after each generation attempt (success AND failure —
  outcome field). A logging failure must never break or delay the handoff.
- Resolve agent dir via pi's own agent-dir resolution (`PI_CODING_AGENT_DIR`
  env → `~/.pi/agent`), consistent with how settings/config paths resolve.
- `mkdir -p` the data dir on first write; append-only, one JSON object per line.
- New `infrastructure/cost-logger.ts`; called from `application/prompt-generator.ts`
  where `HandoffPromptResult` (durationMs, outputChars, model ids) is produced.
- Tests: append behavior, malformed-agent-dir tolerance, one line per attempt.

