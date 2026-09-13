# pi-handoff

Context handoff for the [pi coding agent](https://github.com/earendil-works/pi) — transfer session context to a new focused session using LLM-generated prompts. Gathers git state, session history, and active tasks, then generates a structured handoff prompt for the next session.

## Features

| Feature | Description |
| ------- | ----------- |
| `/handoff` command | Cold-session path, registered in every session. Snapshots the session, generates the handoff in a one-off LLM call on `handoff.provider`/`model`/`effort`, then **directly launches the new session** seeded with the filled template — no document file is created anywhere (no-doc rehaul, 2026-09-13). |
| Streaming progress loader | One continuous loader spans the whole flow with live phase lines: `Gathering context…` → `Memory pre-flight: agent persisting session learnings… (Xs)` (elapsed ticks per second) → `Snapshotting context (N messages, X chars)…` → generation. Escape still cancels. |
| Model display & generation status | Shows which model generates the prompt — `Generating with provider/model (effort: …)` — plus a `fallback: …` line naming the model actually used when the configured one is unavailable, and a coarse `generating…` transition once the response lands (generation runs through pi's model runtime, which exposes no per-token stream). After saving, the notify reports `generated with <model-id> in Xs`. |
| Diary reminder | Before the handoff prompt is generated, nudges the agent (one injected suggestion) to persist durable session learnings to MemPalace via `mempalace_diary_write`. The agent skips on its own if it already wrote a diary entry this session or nothing is worth recording. Requires the `mempalace_diary_write` tool to be active; disable with `handoff.diaryReminder: false`. |
| Terminal multiplexer support | Auto-submits the handoff via **tmux** or **herdr** based on config — no manual Enter needed. |
| Herdr shared memory | When using herdr, stores pane/workspace/tab context to `$AGENT_DIR/.herdr-handoff-context.json` so other extensions can locate this session. |
| Lifecycle events | Emits `handoff_command_start/complete` events on the event bus for other extensions to react to. |
| Failure fallback | If the handoff cannot launch (invalid `## Next Task`, session creation cancelled), the generated handoff text is copied to the clipboard and printed to stderr so nothing paid-for is lost. |
| Anchor repo support | When the workspace isn't a git repo itself but contains sub-directory git repos, gathers git state from each sub-repo individually. |
| No-doc handoff flow | Neither path writes a document file — the filled template is injected directly as the new session's first message (provenance line + template + canonical Phase Adherence). The warm path's `continue` toolCall itself is the durable stash; the cold path launches straight from the executor. If a launch fails, the generated text is rescued to clipboard + stderr. |
| Sensitive info redaction | Instructs the LLM to redact API keys, passwords, tokens, and PII with `[REDACTED]` placeholders. |
| Document-file tracking | The handoff template's `## Document Files` section lists document files (`.md`/`.txt`/`.rst`/`.adoc`) created or edited in the session — union of git status (`--untracked-files=all`, catches subagent and manual edits) and the session's write/edit calls, with `in-session`/`git-only` provenance. Code files stay out: git context already carries working-tree state. |
| Previous-session linkage | Every handoff carries a machine-computed provenance line (`<!-- pi-handoff v2 \| session: … \| saved: … -->`) and the new session receives a hidden `handoff-origin` entry recording the parent session JSONL path, profile, and the full document — so the next session can consult the original transcript when the doc alone is not enough. The `↩ Continued from previous session` notify surfaces the linkage at session start. |
| Skip-list for no-value tool calls | `handoff.skipTools` stubs selected tool calls (default: MemPalace diary writes + reconnect, Jira assign/update) out of the serialized conversation before generation — post-hoc memory re-encodings and mutation receipts add noise, not context. Keep-side calls (memory recall, Jira reads) pass through verbatim. |
| Artifact deduplication | References specs, plans, ADRs, and issues by path/URL instead of duplicating their content. |
| Suggested skills | Includes a section recommending skills the new session should invoke based on work context. |
| Phase adherence | Generated prompt ends with a mandatory phase-adherence instruction for the receiving agent. |
| Event hooks | Automatically injects handoff context when sessions end or context limits are approached. |

## Architecture

```text
index.ts                          Entry point — unified registration of all three surfaces
├── skills/
│   └── pi-handoff/               Shipped skill — primary agent instructions
├── tools/
│   └── continue.ts               continue tool — takes the filled template inline, stages bare /continue
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
│   ├── handoff-template.ts       Versioned output template (skill + /handoff)
│   ├── document-files.ts         Document-file policy (allowlist + denylist)
│   └── provenance.ts             Provenance-header stamp helper
├── infrastructure/
│   ├── event-registration.ts     Hooks into pi lifecycle events
│   ├── event-channels.ts         Lifecycle event channel names + emit helpers
│   ├── terminal-strategy.ts      Abstracts tmux/herdr multiplexer selection
│   ├── tmux-client.ts            Tmux session management
│   ├── herdr-client.ts           Herdr session management + shared memory
│   ├── session-adapter.ts        Session file discovery and parsing
│   ├── llm-client.ts             LLM generation adapter (via ModelRegistry)
│   ├── git-client.ts             Git state extraction
│   ├── document-files.ts         Document-file extractor (git status ∪ tool log)
│   ├── tool-skip.ts              handoff.skipTools pre-serialization stub filter
│   └── config-repository.ts      Settings file loading + agent-dir resolution
└── ui/
    └── handoff-loader.ts         Custom TUI loader during generation
```

Design docs: [docs/design/](design/) — e.g. the 2026-09-13 [template-unification design](design/2026-09-13-template-unification.md) (versioned handoff template, document-file tracking, `/continue` linkage, `handoff.skipTools`) resolving the three open backlog items of that date.

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
/handoff                      Hand off to a new session via a one-off LLM call that directly launches the successor
/handoff fix the auth bug     Generate the handoff with a specific goal for the next session
```

Both entry points are always available, and both end in the same tail: the new session is seeded **directly** with the filled template — provenance line + document + canonical Phase Adherence as the first message. No document file is ever created.

- **Cold session — `/handoff [goal]`**: snapshots the conversation and generates the document in a **one-off LLM call** on `handoff.provider`/`model`/`effort`, then directly launches the new session. If `## Next Task` is missing or the launch fails, the generated text is rescued to clipboard + stderr.
- **Warm/active session — just ask for a handoff in natural language**: the agent follows the shipped `pi-handoff` skill — it fills the document template and calls the `continue` tool with the full text inline; the tool validates, strips the trailing Phase Adherence section, stages bare `/continue`, and the existing herdr/tmux auto-submit fires it on turn end (no manual Enter needed). The `/continue` command recovers the newest `continue(document)` toolCall from the session branch — restart-safe, and also the manual recovery path (type `/continue`).

Press Enter (or let herdr/tmux auto-submit) and the `/continue` command launches the new session.

### Progress phases

While the handoff runs, a single loader shows each phase as it happens — no more silent waits:

```text
Gathering context…
Memory pre-flight: agent persisting session learnings… (12s)   ← ticks every second
Snapshotting context (42 messages, 18.4k chars)…
Generating handoff prompt · context: 18.4k
Generating with deepseek/deepseek-v4-flash (effort: low)
Generating with deepseek/deepseek-v4-flash · generating…
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
| `effort` | `string` | — | Thinking level for `/handoff` generation (`"low"`, `"medium"`, `"high"`). Maps natively on Bedrock and OpenAI-compatible providers (zai/deepseek/openai); **unmapped on direct-Anthropic models** — see [docs/backlog/effort-anthropic-direct.md](docs/backlog/effort-anthropic-direct.md). |
| `skipTools` | `string[]` | mempalace diary + reconnect, Jira assign/update | Glob patterns (`*` = zero-or-more chars) for tool calls to **stub out** of the serialized conversation before generation — post-hoc re-encodings and mutation receipts, not context. Matched against tool-call and tool-result names; a user list **replaces** the defaults; `[]` disables; malformed values are ignored with a warning. Note: repo discovery reads the filtered text, so patterns matching path-carrying tools narrow git-repo discovery accordingly. |
| `terminal` | `"tmux"` \| `"herdr"` | auto-detect | Which terminal multiplexer to use for auto-submit. When omitted, auto-detects from environment. |
| `diaryReminder` | `boolean` | `true` | When enabled, `/handoff` nudges the agent to write a MemPalace diary entry (`mempalace_diary_write`) before the handoff prompt is generated. Skipped automatically when the tool is not active. |

All `handoff` settings are read once at extension startup — changing any of them requires a session restart.

### Terminal modes

- **`"tmux"`** (default): Uses `tmux send-keys` to auto-submit the staged `/continue` command after the warm-path handoff tool succeeds (the cold path launches directly and never stages).
- **`"herdr"`**: Uses `herdr pane send-keys` for the same auto-submit flow. Additionally stores the Herdr pane context (workspace, tab, pane ids) to `$AGENT_DIR/.herdr-handoff-context.json` so other extensions can locate this session's Herdr pane.

### The unified flow (two entry points, one tail)

Both entry points produce the same result — a new session whose first message **is** the filled handoff template (preceded by a machine-computed provenance line, followed by the canonical Phase Adherence). Nothing is written to disk.

```
$AGENT_DIR/data/pi-handoff/handoff-<timestamp>.md
```

(`$AGENT_DIR` is `PI_CODING_AGENT_DIR`, default `~/.pi/agent`; the file name uses an ISO-8601 timestamp with colons/dots as dashes so `/continue`'s newest-doc lookup stays correct.)

- **Cold session: `/handoff [goal]`** — snapshots the conversation and generates the document in a **one-off LLM call** on `handoff.provider`/`model`/`effort`, so a cold prefix never costs a premium-model turn, then **directly launches** the successor session (the command context is the only holder of session-creation authority). If `## Next Task` is missing or the launch fails/cancels, the generated text is rescued to clipboard + stderr.
- **Warm/active session: just ask for a handoff** — the agent follows the shipped **pi-handoff skill**, the primary instruction source (flow, document contract, exact output template, `continue` usage). It fills the template — the session's own model already has the history in its prompt cache — then calls the **`continue`** tool with `{"document": …}` (the full text inline; the toolCall itself is the durable stash in the session JSONL). The tool validates (a non-empty `## Next Task`; on failure it reports what to repair and the agent fixes the text — a self-healing loop), strips the trailing Phase Adherence section, computes the provenance line, and stages bare `/continue`; herdr/tmux auto-submit after the turn ends and the new session starts with the document inline.

The `/handoff` executor launches the new session itself (direct `createHandoffSession`); the warm path's `continue` tool cannot (session creation is command-context-only in pi) — that is why it stages `/continue`, which owns the launch on that path. The hidden `handoff-origin` entry (leaf label, parent session, profile, full document) is written by the shared `createHandoffSession` for both paths.

Notes:

- `handoff.type` is deprecated: parsed for backward compatibility, ignored. All three surfaces (`/handoff`, `/continue`, `continue`) register in every session.
- `/continue` is general-purpose: an existing file path seeds it as read-first handoff context; ANY OTHER TEXT is sent to a new session as-is (no handoff machinery); no argument uses the newest `handoff-*.md` (manual recovery when auto-submit missed).
- The handoff document is NOT pre-loaded into the new session (docs can be large) — the new session's single visible first message carries the document path plus a read-first instruction, the document's `## Next Task`, and the canonical `## Phase Adherence` owned by the extension (model-authored variants never leak into the new session's first message).

### Lifecycle events

The extension emits events on the pi event bus. Other extensions can listen:

| Channel | When | Payload |
| ------- | ---- | ------- |
| `handoff_command_start` | `/handoff` command began | `{ goal, quickMode, timestamp }` |
| `handoff_command_complete` | `/handoff` command finished | `{ goal, quickMode, sessionTitle?, artifactPath?, error?, timestamp }` |

## Testing

`npm test` runs a behavioral smoke suite (182 checks). It stages the repo's TypeScript tree into a temp ESM context, stubs the `@earendil-works/*` runtime packages through node module hooks (repo devDep versions drift from pi's runtime aliases), loads the staged extension, and asserts: identical registration across settings shapes, the `/handoff` executor directly launching the successor (no save, no editor, no staging) with rescue-to-clipboard on every failure mode, registry-routed generation with `cacheRetention: "none"` and intact auth-by-construction, the continue tool's inline-document validate/repair loop + bare-`/continue` staging, branch-based bare-`/continue` recovery (newest-wins, restart-safe), the single-message continuation prompt (provenance + document + canonical Phase Adherence exactly once), lifecycle event pairing + the `↩ Continued` origin-entry notify, template/skill byte-sync, document-file extraction (git `--untracked-files=all` + tool-log union), the `handoff.skipTools` filter (matcher, defaults incl. `continue`, override/disable/malformed, clone-before-mutate), and the **zero-filesystem-writes invariant** across both flows (agent dir + repo + tmpdir snapshots).

## License

MIT
