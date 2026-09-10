# pi-handoff

Context handoff for the [pi coding agent](https://github.com/earendil-works/pi) — transfer session context to a new focused session using LLM-generated prompts. Gathers git state, session history, and active tasks, then generates a structured handoff prompt for the next session.

## Features

| Feature | Description |
| ------- | ----------- |
| `request_handoff` tool | Agent-callable tool that pre-fills the `/handoff` command with a goal string. Fire-and-forget — sets the TUI editor text and stops. Registered in every session. |
| `/handoff` command | Cold-session path, registered in every session. Interactive slash command that snapshots the session, generates the handoff document in a one-off LLM call on `handoff.provider`/`model`/`effort`, saves it to the handoff data dir, and stages `/continue <docPath>` in the editor to launch the new session. |
| `/handoff!` quick mode | Quick mode for `/handoff` — skips the editor review step and stages `/continue <docPath>` from the generated document right away. |
| Streaming progress loader | One continuous loader spans the whole flow with live phase lines: `Gathering context…` → `Memory pre-flight: agent persisting session learnings… (Xs)` (elapsed ticks per second) → `Snapshotting context (N messages, X chars)…` → generation. Escape still cancels. |
| Model display & streaming counts | Shows which model generates the prompt — `Generating with provider/model (effort: …)` — plus a `fallback: …` line naming the model actually used when the configured one is unavailable, and live output counters as it streams (`thinking… 1.2k`, `writing… 2.3k chars`). After saving, the notify reports `generated with <model-id> in Xs`. |
| Diary reminder | Before the handoff prompt is generated, nudges the agent (one injected suggestion) to persist durable session learnings to MemPalace via `mempalace_diary_write`. The agent skips on its own if it already wrote a diary entry this session or nothing is worth recording. Requires the `mempalace_diary_write` tool to be active; disable with `handoff.diaryReminder: false`. |
| Terminal multiplexer support | Auto-submits the handoff via **tmux** or **herdr** based on config — no manual Enter needed. |
| Herdr shared memory | When using herdr, stores pane/workspace/tab context to `$AGENT_DIR/.herdr-handoff-context.json` so other extensions can locate this session. |
| Lifecycle events | Emits `handoff_tool_start/end`, `handoff_command_start/complete` events on the event bus for other extensions to react to. |
| Failure fallback | If the handoff document cannot be saved, prints the handoff prompt to terminal stderr and copies to clipboard so the user can paste manually. |
| Anchor repo support | When the workspace isn't a git repo itself but contains sub-directory git repos, gathers git state from each sub-repo individually. |
| Handoff document artifact | Saves the handoff document to the handoff data dir (`$AGENT_DIR/data/pi-handoff/handoff-<timestamp>.md`), not the workspace — the same place `/continue` looks for it. |
| Sensitive info redaction | Instructs the LLM to redact API keys, passwords, tokens, and PII with `[REDACTED]` placeholders. |
| Artifact deduplication | References specs, plans, ADRs, and issues by path/URL instead of duplicating their content. |
| Suggested skills | Includes a section recommending skills the new session should invoke based on work context. |
| Phase adherence | Generated prompt ends with a mandatory phase-adherence instruction for the receiving agent. |
| Event hooks | Automatically injects handoff context when sessions end or context limits are approached. |

## Architecture

```text
index.ts                          Entry point — unified registration of all four surfaces
├── skills/
│   └── pi-handoff/               Shipped skill — primary agent instructions
├── tools/
│   ├── request-handoff.ts        request_handoff tool — pre-fills /handoff (every session)
│   └── continue.ts               continue tool — stages /continue <docPath> (skill flow)
├── commands/
│   ├── handoff.ts                /handoff command — cold-session generation path
│   └── continue.ts               /continue command — the shared continuation tail
├── application/
│   ├── context-gatherer.ts       Collects git state, session history, tasks
│   ├── prompt-generator.ts       Builds system/user prompts, resolves model
│   ├── handoff-executor.ts       Orchestrates the /handoff cold-session flow
│   ├── session-creator.ts        New-session creation (owned by the /continue command)
│   └── diary-reminder.ts         MemPalace diary pre-flight
├── domain/
│   ├── types.ts                  Core types (HandoffSettings, GitContext, etc.)
│   ├── handoff-prompt.ts         Continuation prompt composer, Next Task validation
│   └── handoff-template.ts       Shared output template (skill + /handoff)
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
/handoff                      Hand off to a new session via a one-off LLM call (opens editor for review)
/handoff fix the auth bug     Generate the handoff with a specific goal for the next session
/handoff!                     Quick mode — skip the editor review
```

Both entry points are always available, and both end in the same tail: `/continue <docPath>` staged in the editor, which launches the new session.

- **Cold session — `/handoff`** (or the `request_handoff` tool, which pre-fills it): snapshots the conversation and generates the document in a **one-off LLM call** on `handoff.provider`/`model`/`effort`, saves it to the handoff data dir, and stages `/continue <docPath>`.
- **Warm/active session — just ask for a handoff in natural language**: the agent follows the shipped `pi-handoff` skill — it picks the document path, writes the document itself, and calls the `continue` tool, which stages `/continue <docPath>`.

Press Enter (or let herdr/tmux auto-submit) and the `/continue` command launches the new session.

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

Add an optional `handoff` block to your pi profile's `settings.json` (under `$AGENT_DIR` — `PI_CODING_AGENT_DIR`, default `~/.pi/agent`):

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
| `type` | `"detached"` \| `"in-session"` | — | **Deprecated — parsed for backward compatibility and IGNORED.** The unified flow registers every surface in every session, so this key has no effect; safe to delete. |
| `provider` | `string` | — | Provider id for the `/handoff` generation model (e.g. `"deepseek"`, `"amazon-bedrock"`). |
| `model` | `string` | — | Model id used by `/handoff`. Bare id when `provider` is set, or `provider/model` reference. |
| `effort` | `string` | — | Thinking level for `/handoff` generation (`"low"`, `"medium"`, `"high"`). |
| `terminal` | `"tmux"` \| `"herdr"` | auto-detect | Which terminal multiplexer to use for auto-submit. When omitted, auto-detects from environment. |
| `diaryReminder` | `boolean` | `true` | When enabled, `/handoff` nudges the agent to write a MemPalace diary entry (`mempalace_diary_write`) before the handoff prompt is generated. Skipped automatically when the tool is not active. |

All `handoff` settings are read once at extension startup — changing any of them requires a session restart.

### Terminal modes

- **`"tmux"`** (default): Uses `tmux send-keys` to auto-confirm the editor review overlay and auto-submit the `/handoff` command after `request_handoff`.
- **`"herdr"`**: Uses `herdr pane send-keys` for the same auto-submit flow. Additionally stores the Herdr pane context (workspace, tab, pane ids) to `$AGENT_DIR/.herdr-handoff-context.json` so other extensions can locate this session's Herdr pane.

### The unified flow (two entry points, one tail)

Both entry points produce the same artifact — a handoff document in the handoff data dir:

```
$AGENT_DIR/data/pi-handoff/handoff-<timestamp>.md
```

(`$AGENT_DIR` is `PI_CODING_AGENT_DIR`, default `~/.pi/agent`; the file name uses an ISO-8601 timestamp with colons/dots as dashes so `/continue`'s newest-doc lookup stays correct.)

- **Cold session: `/handoff [goal]`** — snapshots the conversation and generates the document in a **one-off LLM call** on `handoff.provider`/`model`/`effort`, so a cold prefix never costs a premium-model turn. The document opens in an editor review (`/handoff!` skips it), saved to the data dir, validated for a non-empty `## Next Task` section, and `/continue <docPath>` is staged in the editor. If `## Next Task` is missing nothing is staged — the run reports the saved path and you fix the document (or re-run `/handoff`).
- **Warm/active session: just ask for a handoff** — the agent follows the shipped **pi-handoff skill**, the primary instruction source (flow, document contract, exact output template, `continue` usage). It writes the document itself — the session's own model already has the history in its prompt cache — then calls the **`continue`** tool, the final step, only after the document is complete on disk. The tool validates the document (a non-empty `## Next Task`; on failure it reports what to repair and the agent fixes the file — a self-healing loop) and stages `/continue <docPath>`. Press Enter (or let herdr/tmux auto-submit after the turn ends) and the new session starts with the Next Task.

The `/handoff` executor never creates or replaces the session itself — it stages `/continue <docPath>` in the editor, exactly like the `continue` tool. The **`/continue` command owns new-session creation** (leaf label, hidden `handoff-origin` entry, live first message) for both entry points.

Notes:

- `handoff.type` is deprecated: parsed for backward compatibility, ignored. All four surfaces (`/handoff`, `request_handoff`, `/continue`, `continue`) register in every session.
- `/continue` is general-purpose: an existing file path seeds it as read-first handoff context; ANY OTHER TEXT is sent to a new session as-is (no handoff machinery); no argument uses the newest `handoff-*.md` (manual recovery when auto-submit missed).
- The handoff document is NOT pre-loaded into the new session (docs can be large) — the new session's single visible first message carries the document path plus a read-first instruction, the document's `## Next Task`, and the canonical `## Phase Adherence` owned by the extension (model-authored variants never leak into the new session's first message).

### Lifecycle events

The extension emits events on the pi event bus. Other extensions can listen:

| Channel | When | Payload |
| ------- | ---- | ------- |
| `handoff_tool_start` | `request_handoff` tool called | `{ goal, command, timestamp }` |
| `handoff_tool_end` | `request_handoff` tool finished | `{ goal, command, timestamp }` |
| `handoff_command_start` | `/handoff` command began | `{ goal, quickMode, timestamp }` |
| `handoff_command_complete` | `/handoff` command finished | `{ goal, quickMode, sessionTitle?, artifactPath?, error?, timestamp }` |

## Testing

`npm test` runs a behavioral smoke suite (61 checks). It stages the repo's TypeScript tree into a temp ESM context, stubs the `@earendil-works/*` runtime packages through node module hooks (repo devDep versions drift from pi's runtime aliases), loads the staged extension, and asserts: identical registration across settings shapes (`handoff.type` set or absent, no settings file), the `/handoff` executor staging `/continue` without creating a session, the continue tool's validate/repair loop, the single-message continuation prompt with canonical Phase Adherence, lifecycle event pairing, stale-ctx emit ordering, and the `/continue` modes (bare → newest doc, generic text, no docs).

## License

MIT
