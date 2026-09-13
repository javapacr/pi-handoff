# Command-path orphan `pendingAutoSubmit` — stray Enter into the new session

**Status:** open (observed 2026-09-12 during the unified-flow pane probe; not
observed to cause harm — pi likely ignores an empty submitted input). The
staging-phase `tui_filled_handoff` emit arms the agent_end-gated auto-submit,
but on the `/handoff` command path no agent_end follows (the staged
`/continue` is submitted by the `tui_handoff_completed` delayed-Enter listener
instead). The pending flag therefore survives into the next session's first
turn; when that turn ends within the 30s safety window, one stray Enter is
sent to the captured pane. Fix options: have the `tui_handoff_completed`
listener clear the pending flag (touches the pinned
`infrastructure/event-registration.ts`), or leave as-is if post-rollout
observation shows no user-visible effect.

