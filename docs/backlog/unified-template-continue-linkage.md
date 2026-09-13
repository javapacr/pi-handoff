# All handoff styles emit the same template — `/continue` seeds the next session with previous-session linkage

**Status:** open, needs planning (2026-09-13, owner direction)

Owner direction: whatever surface produces a handoff, the output is **the
same template** (defined in
[handoff-template-rehaul.md](handoff-template-rehaul.md)). The doc is
passed to `/continue` to send to the next session, **along with the
linkage of the previous session**.

### Shape

- One template, every style — detached `/handoff` generation and every
  other handoff path produce compatible docs; no per-surface formats.
- `/continue` receives the doc + **previous-session linkage**: enough to
  reference the prior session back (session id, profile, session-JSONL
  path) so the new session can consult the original transcript when the
  doc alone is not enough.

### Open questions

- Linkage format: bare session id, `~/.pi/<profile>/sessions/…jsonl`
  path, or both. Does `/continue` validate the link still exists?
- How the linkage reaches the new session: header in the doc, `/continue`
  argument, or both (doc header for humans, argument for the tool).
- The linkage must survive manual edits to the doc — users edit handoff
  docs.
- Interplay with the unified-flow surfaces (`/handoff`,
  `request_handoff`, `/continue`, `continue` tool) that already register
  in-session ([in-session-handoff-mode.md](in-session-handoff-mode.md)
  records that unification).
