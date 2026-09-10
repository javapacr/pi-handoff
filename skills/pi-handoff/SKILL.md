---
name: pi-handoff
description: Hand off the current session's context to a new focused session. Use when the user asks for a handoff or wants to continue work in a fresh session.
---

# pi-handoff — session handoff flow

You are handing this session's context to a NEW focused session. The handoff
document is the bridge: the new session's first message carries the document
path (with a read-first instruction), the document's `## Next Task` section,
and the canonical `## Phase Adherence` — one message, doc body pulled from
disk on demand.

## Which entry point?

- **Warm/active session (this one)** — follow the flow below: write the
  document yourself and call the `continue` tool. The session's history is
  already in the model's prompt cache, so generating the document here is the
  cheap path.
- **Cold session, or a context that has grown very long** — do NOT write the
  document yourself. Tell the user to run `/handoff [goal]` (or call the
  `request_handoff` tool with their goal verbatim and stop): that path
  snapshots the session and generates the document in a one-off detached LLM
  call on the configured `handoff.provider`/`model`/`effort`. A fresh
  premium-model turn over a cold prefix is expensive there; the detached call
  is not.

Both entry points end in the same tail: the editor is staged with
`/continue <docPath>`, and the new session starts from that document.

## The flow (warm/active session — via the `continue` tool)

When the user asks for a handoff (or you propose one and they agree):

1. **Pick the document path.** Data dir:
   `$PI_CODING_AGENT_DIR/data/pi-handoff/` (resolve `PI_CODING_AGENT_DIR`
   from the environment; default `~/.pi/agent`). `mkdir -p` it, then use
   `handoff-<timestamp>.md` — ISO-8601 timestamp with colons/dots as dashes
   (e.g. `handoff-2026-09-02T18-30-00-000Z.md`; this keeps `/continue`'s
   newest-doc lookup correct).
2. **Write the document** to that exact path. The file contains ONLY the
   document: no preamble, no code fences, no closing remarks. Follow the
   document contract below.
3. **Call the `continue` tool** with `{"docPath": "<the exact path>"}`. It
   validates the document and fills the TUI input with
   `/continue <docPath>`. If it reports the document is invalid (missing or
   empty `## Next Task`), fix the file and call it again — the repair loop.
4. **Stop** — after `continue` succeeds, no further tool calls; keep any
   reply to one short line. The user confirms the launch (or herdr/tmux
   auto-submits it), and the new session starts with your `## Next Task`.

Note: this session may itself have been started from a previous handoff (a
"Handoff Context" message with a document path). That does not change
anything — the new handoff covers the whole conversation, including that
context.

## Document contract

Use EXACTLY this output format — omit any section that has no content:

```markdown
## Context
[What was done, key decisions, approaches — 3-8 bullet points. Reference specs, plans, ADRs, issues by path/URL instead of duplicating.]

## Git State

### repo-name (/path/to/repo)
Branch: <branch>
Recent changes:
- path/to/file — what changed

Recent commits:
- abc1234 message

## Active Tasks
- [ ] pending task
- [x] completed task

## Suggested Skills
Invoke on start: skill-a, skill-b

## Working Directory
/path/to/project

## Next Task
[Clear, actionable statement of the goal for this new session]

## Phase Adherence
This is a handoff from a previous session. Phase adherence as defined in the system prompt is mandatory — classify this request through CLASSIFICATION and follow the appropriate phase workflow. Do not skip phases.
```

This template mirrors `domain/handoff-template.ts` (`HANDOFF_OUTPUT_TEMPLATE`)
— keep the two in sync. The detached mode's system prompt embeds the same
template from that constant.

Non-negotiable rules:

- **REDACT** all secrets, credentials, tokens, and PII as `[REDACTED]`.
- **Reference** artifacts (specs, plans, ADRs, issues) by path/URL — never
  duplicate their content.
- **`## Next Task` is the new session's first instruction.** It must state the
  actual WORK to continue — never instructions about the handoff itself, never
  "verify the handoff", never meta-commentary. If a goal was given, the Next
  Task serves that goal.
- **`## Phase Adherence`** — write the paragraph verbatim as shown. The
  extension appends its own canonical copy to the live message regardless;
  keeping the document consistent still matters.
- Do NOT write anything after `## Phase Adherence`.

## The `continue` tool

- **Purpose**: fill the TUI input with the `/continue <docPath>` command once
  the handoff document is complete on disk. It is the LAST step — call it only
  after the file is written and correct.
- **Validate-first**: it re-reads the file and rejects it (isError result) if
  `## Next Task` is missing or empty. Repair and re-call.
- **After success**: stop. Auto-submit (herdr/tmux) or the user's Enter runs
  `/continue`, which creates the new session — seeded with the document path
  (the doc is NOT pre-loaded; the new session reads it from disk) — and sends
  your `## Next Task` plus the canonical Phase Adherence as its live message.

## `/continue [docPath | text]`

- `/continue <docPath>` — launch from a written handoff document (what the
  `continue` tool pre-fills). Re-validates before launching.
- `/continue <text>` — no handoff involved: the text is sent AS-IS as a new
  session's live message. Useful whenever the user wants to continue in a
  fresh session with a specific instruction.
- `/continue` (no argument) — uses the newest `handoff-*.md` in the data dir
  (manual recovery when auto-submit missed).
