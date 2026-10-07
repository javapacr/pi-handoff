# Command-path orphan `pendingAutoSubmit` — stray Enter into the new session

**Status:** open — reassessed 2026-10-07; risk reduced, close after one
observation round (see Reassessment below).

**Original observation (2026-09-12)**, during the unified-flow pane probe; not
observed to cause harm — pi likely ignores an empty submitted input. The
staging-phase `tui_filled_handoff` emit arms the agent_end-gated auto-submit,
but on the `/handoff` command path no agent_end follows (the staged
`/continue` is submitted by the `tui_handoff_completed` delayed-Enter listener
instead). The pending flag therefore survives into the next session's first
turn; when that turn ends within the 30s safety window, one stray Enter is
sent to the captured pane. Fix options: have the `tui_handoff_completed`
listener clear the pending flag (touches the pinned
`infrastructure/event-registration.ts`), or leave as-is if post-rollout
observation shows no user-visible effect.

## Reassessment 2026-10-07 (pi 1.0 conformance pass)

Design note: [../design/2026-10-07-pi-1.0-conformance.md](../design/2026-10-07-pi-1.0-conformance.md).

- **The trigger path above is gone.** The no-doc rehaul W2 (`d846274`) made
  the `/handoff` command path launch directly: it no longer stages, no longer
  emits `tui_filled_handoff`, and the `tui_handoff_completed` listener and
  channel were deleted (smoke: "NO tui_filled_handoff / NO
  tui_handoff_completed emissions (direct launch)", "tui_handoff_completed
  channel deleted from the bus map"). The only emitter of
  `tui_filled_handoff` is now the `continue` tool, which runs inside an agent
  run, so the arming is always followed by that run's settle.
- **Auto-submit now fires on `agent_settled`, not `agent_end`.** `agent_end`
  can be followed by retries, compaction, or queued work; `agent_settled`
  fires only once pi will not continue automatically. The Enter can no longer
  land mid-retry or mid-compaction.
- **`session_shutdown` now clears the pending flag** (idempotent). Quit,
  reload, and session replacement (including the `/continue` launch itself)
  release `pendingAutoSubmit` + `pendingFlagTimer`, so a flag cannot cross
  into the successor runtime even if the module instance is reused.
- **Residual risk:** a run that never settles within the 30s safety timeout
  (e.g. a long compaction after the `continue` call) clears the flag and the
  user presses Enter manually; this fails safe (no stray Enter). The 200ms
  delayed `sendEnter` timer is not tracked, so a shutdown inside that 200ms
  window still sends one Enter to the captured pane.

Not closed: nothing here was observed in a live pane after the change. Close
after one herdr warm-path handoff confirms a single Enter and no stray input.
