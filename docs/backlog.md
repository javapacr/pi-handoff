# pi-handoff backlog index

One file per item in [backlog/](backlog/). This index is the status board — update the row when a file's status changes; never inline item content here. New items get a file plus a row; completed items keep their file with the row marked DONE.

| Item | Status |
| --- | --- |
| [Detached generation bypasses pi's model runtime — Bedrock `Validation error`](backlog/bedrock-validation-error.md) | approved — next up (2026-09-13), scoped to `/handoff` |
| [`cacheRetention: "none"` on the detached generation call](backlog/cache-retention-none.md) | approved — next up (2026-09-13), scoped to `/handoff` |
| [Rehaul of handoff generation — agent-driven template + document-file tracking](backlog/handoff-template-rehaul.md) | planned — design resolved 2026-09-13 ([design](design/2026-09-13-template-unification.md)) |
| [All handoff styles emit the same template; `/continue` seeds the next session with previous-session linkage](backlog/unified-template-continue-linkage.md) | planned — design resolved 2026-09-13 ([design](design/2026-09-13-template-unification.md)) |
| [Command-path orphan `pendingAutoSubmit` — stray Enter into the new session](backlog/pending-autosubmit-orphan.md) | open — observe for user-visible effect |
| [Fast-path detached generation — tiered payload pipeline](backlog/fast-path-payload-pipeline.md) | open — idea |
| [Skip-list for tool calls in session-JSONL parsing (mempalace, Jira writes)](backlog/skip-tool-calls-serialization.md) | planned — design resolved 2026-09-13 ([design](design/2026-09-13-template-unification.md)) |
| [`handoff.effort` unmapped on anthropic-direct after the registry migration](backlog/effort-anthropic-direct.md) | open — documented limitation, zero current impact |
| [Own compaction extension — `pi-compact/`](backlog/pi-compact-extension.md) | open — idea |
| [pi-cache-window — idle prompt-cache countdown + cold-resume advisor](backlog/pi-cache-window.md) | planned 2026-09-11 — parked by owner |
| [Detached payload size — does the cold path still earn its keep?](backlog/detached-payload-size.md) | parked 2026-09-13 |
| [Cost tracking for summarization — `cost.jsonl`](backlog/cost-tracking-cost-jsonl.md) | parked 2026-09-02 |
| [In-session handoff mode — `handoff.type: "in-session"`](backlog/in-session-handoff-mode.md) | superseded 2026-09-12 |

Split from root `BACKLOG.md` on 2026-09-13.
