# pi-handoff

Context handoff for the [pi coding agent](https://github.com/earendil-works/pi) — transfer session context to a new focused session using LLM-generated prompts. Gathers git state, session history, and active tasks, then generates a structured handoff prompt for the next session.

## Features

| Feature | Description |
|---------|-------------|
| `request_handoff` tool | Agent-callable tool that pre-fills the `/handoff` command with a goal string. Fire-and-forget — sets the TUI editor text and stops. |
| `/handoff` command | Interactive slash command that collects session context and generates a handoff prompt for review. |
| `/handoff!` quick mode | Skip the editor review step — generate and output the handoff prompt immediately. |
| Event hooks | Automatically injects handoff context when sessions end or context limits are approached. |

## Architecture

```
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
│   ├── tmux-client.ts        Tmux session management
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

```
/handoff                      Generate handoff prompt (opens editor for review)
/handoff fix the auth bug     Generate handoff with a specific goal
/handoff!                     Quick mode — skip editor, output immediately
```

The agent can also call `request_handoff` as a tool to trigger the flow programmatically.

## License

MIT
