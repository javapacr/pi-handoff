# pi-handoff

Context handoff for the [pi coding agent](https://github.com/earendil-works/pi) — transfer session context to a new focused session using LLM-generated prompts. Gathers git state, session history, and active tasks, then generates a structured handoff prompt for the next session.

## Features

| Feature | Description |
| ------- | ----------- |
| `request_handoff` tool | Detached mode only. Agent-callable tool that pre-fills the `/handoff` command with a goal string. Fire-and-forget — sets the TUI editor text and stops. |
| `/handoff` command | Detached mode only. Interactive slash command that collects session context and generates a handoff prompt for review. |
| `/handoff!` quick mode | Detached mode only. Skip the editor review step — generate and output the handoff prompt immediately. |
| Streaming progress loader | One continuous loader spans the whole flow with live phase lines: `Gathering context…` → `Memory pre-flight: agent persisting session learnings… (Xs)` (elapsed ticks per second) → `Snapshotting context (N messages, X chars)…` → generation. Escape still cancels. |
| Model display & streaming counts | Shows which model generates the prompt — `Generating with provider/model (effort: …)` — plus a `fallback: …` line naming the model actually used when the configured one is unavailable, and live output counters as it streams (`thinking… 1.2k`, `writing… 2.3k chars`). After saving, the notify reports `generated with <model-id> in Xs`. |
| Diary reminder | Detached mode only. Before the handoff prompt is generated, nudges the agent (one injected suggestion) to persist durable session learnings to MemPalace via `mempalace_diary_write`. The agent skips on its own if it already wrote a diary entry this session or nothing is worth recording. Requires the `mempalace_diary_write` tool to be active; disable with `handoff.diaryReminder: false`. |
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
index.ts                          Entry point — mode-selecting registration
├── skills/
│   └── pi-handoff/               Shipped skill — primary agent instructions
├── tools/
│   ├── request-handoff.ts        request_handoff tool registration (detached only)
│   └── continue.ts               continue tool — fills TUI with /continue (in-session mode)
├── commands/
│   ├── handoff.ts                /handoff command — detached registration
│   └── continue.ts               /continue command (in-session mode)
├── application/
│   ├── context-gatherer.ts       Collects git state, session history, tasks
│   ├── prompt-generator.ts       Builds system/user prompts, resolves model
│   ├── handoff-executor.ts       Orchestrates the detached handoff flow
│   ├── session-creator.ts        Shared new-session creation (both modes)
│   └── diary-reminder.ts         MemPalace diary pre-flight
├── domain/
│   ├── types.ts                  Core types (HandoffSettings, GitContext, etc.)
│   ├── handoff-prompt.ts         Prompt splitting, Next Task validation
│   └── handoff-template.ts       Shared output template (both modes)
├── infrastructure/
│   ├── event-registration.ts     Hooks into pi lifecycle events
│   ├── event-channels.ts         Lifecycle event channel names + emit helpers
│   ├── terminal-strategy.ts      Abstracts tmux/herdr multiplexer selection
│   ├── tmux-client.ts            Tmux session management
│   ├── herdr-client.ts           Herdr session management + shared memory
│   ├── session-adapter.ts        Session file discovery and parsing
│   ├── llm-client.ts             LLM generation adapter
│   ├── git-client.ts             Git state extraction
│   └── config-repository.ts      Settings file loading + agent-dir resolution
└── ui/
    └── handoff-loader.ts         Custom TUI loader during generation
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

`/handoff` (and `/handoff!`) is **detached mode only** (the default). The agent can also call `request_handoff` as a tool to trigger that flow programmatically.

In **in-session mode** (`handoff.type: "in-session"`) there is no `/handoff` command — just ask for a handoff in natural language and the agent follows the shipped `pi-handoff` skill: it picks the document path, writes the document, and calls the `continue` tool, which fills the TUI with `/continue <docPath>`.

### Progress phases

While the handoff runs, a single loader shows each phase as it happens — no more silent waits:

```text
Gathering context…
Memory pre-flight: agent persisting session learnings… (12s)   ← ticks every second
Snapshotting context (42 messages, 18.4k chars)…
Generating handoff prompt · context: 18.4k
Generating with deepseek/deepseek-v4-flash (effort: low)
Generating with deepseek/deepseek-v4-flash · thinking… 1.2k
Generating with deepseek/deepseek-v4-flash · writing… 2.3k chars
```

The generation model (and effort level) is always shown before generation starts; if the configured handoff model is unavailable, a `fallback: <model-id>` line names the model actually used. Press Escape at any point to cancel (`prompt: null`, no session created).

### Diary reminder

When `/handoff` runs, the agent is nudged (once, before the handoff prompt is generated) to persist durable session learnings to MemPalace. It skips the diary on its own if it already wrote one this session or nothing durable is worth recording, keeping any reply to a single line. The nudge only fires when the `mempalace_diary_write` tool is active in the session — sessions without the memory system pay no extra turns — and can be disabled with `handoff.diaryReminder: false` in settings.

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
| `type` | `"detached"` \| `"in-session"` | `"detached"` | Generation path for the handoff flow. Selected once at startup — changing it requires a session restart. See [In-session mode](#in-session-mode-handofftype-in-session). |
| `provider` | `string` | — | Provider id for the handoff generation model (e.g. `"deepseek"`, `"amazon-bedrock"`). Detached mode only. |
| `model` | `string` | — | Model id for generation. Bare id when `provider` is set, or `provider/model` reference. Detached mode only. |
| `effort` | `string` | — | Thinking level for generation (`"low"`, `"medium"`, `"high"`). |
| `terminal` | `"tmux"` \| `"herdr"` | auto-detect | Which terminal multiplexer to use for auto-submit. When omitted, auto-detects from environment. |
| `diaryReminder` | `boolean` | `true` | When enabled, `/handoff` nudges the agent to write a MemPalace diary entry (`mempalace_diary_write`) before the handoff prompt is generated. Skipped automatically when the tool is not active. |

### Terminal modes

- **`"tmux"`** (default): Uses `tmux send-keys` to auto-confirm the editor review overlay and auto-submit the `/handoff` command after `request_handoff`.
- **`"herdr"`**: Uses `herdr pane send-keys` for the same auto-submit flow. Additionally stores the Herdr pane context (workspace, tab, pane ids) to `~/.pi/agent/.herdr-handoff-context.json` so other extensions can locate this session's Herdr pane.

### In-session mode (`handoff.type: "in-session"`)

When the summarizer IS the session model (e.g. Sonnet-only profiles), a detached handoff re-sends the serialized conversation at full input rates. In-session mode is instead **fully agent-driven — the shipped pi-handoff skill instructs the agent to write the document and call the continue tool; no instruction turn is injected and no `/handoff` command exists in this mode**. The session's own model — with the full history already in its prompt cache — writes the handoff document to

```
$PI_CODING_AGENT_DIR/data/pi-handoff/handoff-<timestamp>.md
```

then calls the **`continue`** tool — the final step, only after the document is complete on disk. The tool validates the document (a non-empty `## Next Task` section; on failure it reports what to repair and the agent fixes the file — a self-healing loop) and fills the TUI input with `/continue <docPath>`. Press Enter (or let herdr/tmux auto-submit after the turn ends) and the new session starts with the Next Task — the same session-creation path the detached flow uses.

The **pi-handoff skill** (shipped with the extension) is the primary instruction source for agents performing handoffs: the flow, the document contract, the exact output template, and how to use `continue`. The `## Phase Adherence` section of the continuation prompt is owned by the extension (canonical text appended by the tool), so model-authored variants never leak into the new session's first message.

Notes:

- `provider`/`model`/`effort` are ignored in this mode — generation deliberately uses the session's own model.
- `/continue` is general-purpose: an existing file path seeds it as read-first handoff context; ANY OTHER TEXT is sent to a new session as-is (no handoff machinery); no argument uses the newest `handoff-*.md`.
- The handoff document is NOT pre-loaded into the new session (docs can be large) — the session is seeded with the document path plus a read-first instruction, and the content is pulled from disk on demand.

### Lifecycle events

The extension emits events on the pi event bus. Other extensions can listen:

| Channel | When | Payload |
| ------- | ---- | ------- |
| `handoff_tool_start` | `request_handoff` tool called | `{ goal, command, timestamp }` |
| `handoff_tool_end` | `request_handoff` tool finished | `{ goal, command, timestamp }` |
| `handoff_command_start` | `/handoff` command began | `{ goal, quickMode, timestamp }` |
| `handoff_command_complete` | `/handoff` command finished | `{ goal, quickMode, sessionTitle?, artifactPath?, error?, timestamp }` |

## Testing

`npm test` runs a behavioral smoke suite (31 checks). It stages the repo's TypeScript tree into a temp ESM context, stubs the `@earendil-works/*` runtime packages through node module hooks (repo devDep versions drift from pi's runtime aliases), loads the staged extension, and asserts: registration shapes per `handoff.type`, the continue tool's validate/repair loop, the canonical Phase Adherence continuation prompt, lifecycle event pairing, stale-ctx emit ordering, and the `/continue` modes (bare → newest doc, generic text, no docs).

## License

MIT
