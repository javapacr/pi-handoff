---
name: pi-handoff
description: Hand off the current session's context to a new focused session. Use when the user asks for a handoff or wants to continue work in a fresh session.
---

# pi-handoff — session handoff flow

You are handing this session's context to a NEW focused session. There is no
handoff document file: you fill the template in memory and pass it to the
`continue` tool inline. The tool stages `/continue`, and the new session's
first message IS your filled document — the machine-stamped provenance line
prepended by the extension, the canonical `## Phase Adherence` appended at
launch.

## Which entry point?

- **Warm/active session (this one)** — follow the flow below: fill the
  template yourself and call the `continue` tool. The session's history is
  already in the model's prompt cache, so generating the document here is the
  cheap path.
- **Cold session, or a context that has grown very long** — do NOT fill the
  template yourself. Tell the user to run `/handoff [goal]`: that path
  snapshots the session and generates the document in a one-off detached LLM
  call on the configured `handoff.provider`/`model`/`effort`. A fresh
  premium-model turn over a cold prefix is expensive there; the detached call
  is not.

## The flow (warm/active session — via the `continue` tool)

When the user asks for a handoff (or you propose one and they agree):

1. **Fill the template.** Compose the complete document in memory, following
   the document contract below. Nothing is written to disk — no file, no
   directory, no path. The `## Document Files` section is self-computed (see
   below).
2. **Call the `continue` tool** with
   `{"document": "<the filled template, ## Context through ## Next Task>"}` —
   the full text inline as one string. It validates the document and stages
   `/continue`. If it
   reports the document is invalid (missing or empty `## Next Task`), fix the
   document text and call it again with the full corrected document — the
   repair loop.
3. **Stop** — after `continue` succeeds, no further tool calls; keep any
   reply to one short line. The new session launches when your turn ends
   (auto-submit under herdr/tmux) or when the user presses Enter.

Note: this session may itself have been started from a previous handoff. That
does not change anything — the new handoff covers the whole conversation,
including that context.

## Document contract

Use EXACTLY this output format — omit any section that has no content. One
deliberate exception: YOUR document ENDS at `## Next Task`. The `## Phase
Adherence` section in the fence is written by the extension, not by you —
the fence shows the complete template contract (the new session's first
message as composed at launch), not the literal text you produce:

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

## Document Files
[One `- <path> — <in-session|git-only> — <optional one-line what-it-is>` line per document file created or edited this session — omit the section when there are none. The annotation is optional for git-only rows.]

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

This block mirrors `HANDOFF_OUTPUT_TEMPLATE` in
`domain/handoff-template.ts`; a smoke check enforces byte-equality between
this fenced block and that constant — never edit one without the other. The
detached `/handoff` system prompt embeds the same constant. The fence keeps
the Phase Adherence section precisely because it is the TEMPLATE contract —
the canonical copy the extension appends at launch — while your own output
omits it.

### `## Document Files` — compute the list yourself

On this warm path the extension does not gather the list for you. Before
composing the document, derive it under the same definition the extension
uses:

- Files you wrote or edited this session (your own `write`/`edit` calls)
  are `in-session`.
- Files shown by `git status --short --untracked-files=all` (run it per
  relevant repo) that you did not touch in-session are `git-only`.
- Only document files count: `.md`, `.txt`, `.rst`, `.adoc`. Never list
  anything under `node_modules/`, `.git/`, `dist/`, `build/`,
  `$PI_CODING_AGENT_DIR/tmp/`, or handoff staging locations. Omit the
  section when nothing qualifies.

Non-negotiable rules:

- **REDACT** all secrets, credentials, tokens, and PII as `[REDACTED]`.
- **Reference** artifacts (specs, plans, ADRs, issues) by path/URL — never
  duplicate their content.
- **`## Next Task` is the new session's first instruction.** It must state the
  actual WORK to continue — never instructions about the handoff itself, never
  "verify the handoff", never meta-commentary. If a goal was given, the Next
  Task serves that goal.
- **`## Phase Adherence` — OMIT it.** Write the document WITHOUT a Phase
  Adherence section: the extension appends the canonical copy at launch and
  strips any model-authored trailing variant, so a PA you write never
  reaches the new session.
- **Provenance header is machine-stamped.** The extension prepends the
  `<!-- pi-handoff … -->` line to the new session's first message — do NOT
  write that header; it is never model-authored.
- End your document at `## Next Task` — write nothing after it.

## The `continue` tool

- **Purpose**: stage the `/continue` command that launches the new session.
  It is the LAST step — call it with the filled template as
  `{"document": …}` (## Context through ## Next Task, full text inline;
  nothing is written to disk).
- **Validate-first**: it rejects the document (isError result) if
  `## Next Task` is missing or empty. Fix the document text and re-call with
  the full corrected document.
- **After success**: stop. Auto-submit (herdr/tmux) or the user's Enter runs
  `/continue`, which creates the new session — its first message is your
  filled document, with the machine-stamped provenance line and the canonical
  Phase Adherence.

## `/continue [text]`

- `/continue` (no argument) — relaunches from the newest `continue` tool call
  in this session: manual recovery when auto-submit missed, and it survives
  restarts (the document rides the session history).
- `/continue <text>` — no handoff involved: the text is sent AS-IS as a new
  session's live message. (An old-style document path typed here is just
  text.)
