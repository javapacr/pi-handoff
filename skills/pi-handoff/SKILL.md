---
name: pi-handoff
description: Hand off the current session's context to a new focused session. Use when the user asks for a handoff or wants to continue work in a fresh session.
---

# pi-handoff — session handoff flow

You are handing this session's context to a NEW focused session. The handoff
document is the bridge: the new session starts with it pre-seeded, and its
first live instruction is the document's `## Next Task` section.

## The flow (in-session mode)

1. **Trigger** — one of:
   - The user runs `/handoff [goal]`. The extension injects ONE instruction
     turn into THIS session: it tells you the goal (if any), the exact output
     path, and embeds the output template. Follow it.
   - You decide a handoff is needed (or the user asks in prose): call the
     `request_handoff` tool with the user's goal verbatim — do NOT research or
     summarize first. It pre-fills `/handoff <goal>` in the TUI; it auto-runs.
     The injected instruction turn then arrives in this session.
2. **Write the document** — write it to the EXACT path from the instruction
   (the parent directory already exists). The file contains ONLY the document:
   no preamble, no code fences, no closing remarks.
3. **Call the `continue` tool** with `{"docPath": "<the exact path>"}`. It
   validates the document and pre-fills the TUI with the `/continue <docPath>`
   launch command. If it reports the document is invalid (missing or empty
   `## Next Task`), fix the file and call it again — this is the repair loop.
4. **Stop** — after `continue` succeeds, no further tool calls; keep any reply
   to one short line. The user confirms the launch (or herdr/tmux auto-submits
   it), and the new session starts with your `## Next Task`.

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

This template mirrors `domain/handoff-template.ts` (`HANDOFF_OUTPUT_TEMPLATE`) — keep the two in sync. The detached mode's system prompt embeds the same template from that constant.

Non-negotiable rules:

- **REDACT** all secrets, credentials, tokens, and PII as `[REDACTED]`.
- **Reference** artifacts (specs, plans, ADRs, issues) by path/URL — never
  duplicate their content.
- **`## Next Task` is the new session's first instruction.** It must state the
  actual WORK to continue — never instructions about the handoff itself, never
  "verify the handoff", never meta-commentary. If a goal was given, the Next
  Task serves that goal.

## The `continue` tool

- **Purpose**: fill the TUI input with the `/continue <docPath>` command once
  the handoff document is complete on disk. It is the LAST step — call it only
  after the file is written and correct.
- **Validate-first**: it re-reads the file and rejects it (isError result) if
  `## Next Task` is missing or empty. Repair and re-call.
- **After success**: stop. Auto-submit (herdr/tmux) or the user's Enter runs
  `/continue`, which creates the new session with your document.

## `/continue [docPath]`

Creates the new session from a written handoff document: `docPath` optional —
with no argument it uses the NEWEST `handoff-*.md` in the handoff data dir
(`$PI_CODING_AGENT_DIR/data/pi-handoff/`). Useful for manual recovery when
auto-submit missed. It re-validates `## Next Task` before launching.

## Detached mode (`handoff.type: "detached"`, the default)

Without in-session mode, `/handoff` serializes the session and generates the
doc in a separate LLM call (honouring `handoff.provider`/`model`/`effort`
settings) — you are not involved in generation. `request_handoff` and
`/continue` behave the same. The `continue` tool is only registered in
in-session mode.
