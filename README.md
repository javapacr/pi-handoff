# pi-handoff

Context handoff for the [pi coding agent](https://github.com/earendil-works/pi) — transfer session context to a new focused session using LLM-generated prompts. Gathers git state, session history, and active tasks, then generates a structured handoff prompt for the next session.

## Features

| Feature | Description |
| ------- | ----------- |
| `request_handoff` tool | Agent-callable tool that pre-fills the `/handoff` command with a goal string. Fire-and-forget — sets the TUI editor text and stops. |
| `/handoff` command | Interactive slash command that collects session context and generates a handoff prompt for review. |
| `/handoff!` quick mode | Skip the editor review step — generate and output the handoff prompt immediately. |
| Terminal multiplexer support | Auto-submits the handoff via **tmux** or **herdr** based on config — no manual Enter needed. |
| Herdr shared memory | When using herdr, stores pane/workspace/tab context to `~/.pi/agent/.herdr-handoff-context.json` so other extensions can locate this session. |
| Lifecycle events | Emits `handoff_tool_start/end`, `handoff_command_start/complete` events on the event bus for other extensions to react to. |
| Failure fallback | If session creation fails, prints the handoff prompt to terminal stderr and copies to clipboard so the user can paste manually. |
| Anchor repo support | When the workspace isn't a git repo itself but contains sub-directory git repos, gathers git state from each sub-repo individually. |
| Temp file artifact | Saves the handoff document to the OS temp directory (not the workspace) for persistence. |
| Sensitive info redaction | Instructs the LLM to redact API keys, passwords, tokens, and PII with `[REDACTED]` placeholders. |
| Artifact deduplication | References specs, plans, ADRs, and issues by path/URL instead of duplicating their content. |
| Suggested skills | Includes a section recommending skills the new session should invoke based on work context. |
| Phase adherence | Generated prompt ends with a mandatory phase-adherence instruction for the receiving agent. |
| Event hooks | Automatically injects handoff context when sessions end or context limits are approached. |

## Architecture

```text
index.ts                      Entry point — wires tools, commands, events
├── tools/
│   └── request-handoff.ts    request_handoff tool registration
├── commands/
│   └── handoff.ts            /handoff slash command
├── application/
│   ├── context-gatherer.ts   Collects git state, session history, tasks
│   ├── prompt-generator.ts   Builds system/user prompts, resolves model
│   └── handoff-executor.ts   Orchestrates the full handoff flow
├── domain/
│   ├── types.ts              Core types (HandoffSettings, GitContext, etc.)
│   └── handoff-prompt.ts     Handoff prompt template
├── infrastructure/
│   ├── event-registration.ts Hooks into pi lifecycle events
│   ├── event-channels.ts     Lifecycle event channel names + emit helpers
│   ├── terminal-strategy.ts  Abstracts tmux/herdr multiplexer selection
│   ├── tmux-client.ts        Tmux session management
│   ├── herdr-client.ts       Herdr session management + shared memory
│   ├── session-adapter.ts    Session file discovery and parsing
│   ├── llm-client.ts         LLM generation adapter
│   ├── git-client.ts         Git state extraction
│   └── config-repository.ts  Settings file loading
└── ui/
    └── handoff-loader.ts     Custom TUI loader during generation
```

## Install

### As a pi extension (local path)

Add to your pi profile's `package.json`:

```json
{
  "pi": {
    "extensions": [
      "./path/to/pi-handoff"
    ]
  }
}
```

### As an npm package (when published)

```json
{
  "pi": {
    "extensions": [
      "npm:pi-handoff"
    ]
  }
}
```

## Usage

```text
/handoff                      Generate handoff prompt (opens editor for review)
/handoff fix the auth bug     Generate handoff with a specific goal
/handoff!                     Quick mode — skip editor, output immediately
```

The agent can also call `request_handoff` as a tool to trigger the flow programmatically.

## Configuration

Add an optional `handoff` block to your pi `settings.json` (`~/.pi/agent/settings.json`):

```json
{
  "handoff": {
    "provider": "amazon-bedrock",
    "model": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    "effort": "low",
    "terminal": "herdr"
  }
}
```

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `provider` | `string` | — | Provider id for the handoff generation model (e.g. `"deepseek"`, `"amazon-bedrock"`). |
| `model` | `string` | — | Model id for generation. Bare id when `provider` is set, or `provider/model` reference. |
| `effort` | `string` | — | Thinking level for generation (`"low"`, `"medium"`, `"high"`). |
| `terminal` | `"tmux"` \| `"herdr"` | auto-detect | Which terminal multiplexer to use for auto-submit. When omitted, auto-detects from environment. |

### Terminal modes

- **`"tmux"`** (default): Uses `tmux send-keys` to auto-confirm the editor review overlay and auto-submit the `/handoff` command after `request_handoff`.
- **`"herdr"`**: Uses `herdr pane send-keys` for the same auto-submit flow. Additionally stores the Herdr pane context (workspace, tab, pane ids) to `~/.pi/agent/.herdr-handoff-context.json` so other extensions can locate this session's Herdr pane.

### Lifecycle events

The extension emits events on the pi event bus. Other extensions can listen:

| Channel | When | Payload |
| ------- | ---- | ------- |
| `handoff_tool_start` | `request_handoff` tool called | `{ goal, command, timestamp }` |
| `handoff_tool_end` | `request_handoff` tool finished | `{ goal, command, timestamp }` |
| `handoff_command_start` | `/handoff` command began | `{ goal, quickMode, timestamp }` |
| `handoff_command_complete` | `/handoff` command finished | `{ goal, quickMode, sessionTitle?, artifactPath?, error?, timestamp }` |

## License

MIT
