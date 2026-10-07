# pi-handoff backlog index

One file per item in [backlog/](backlog/). This index is the status board — update the row when a file's status changes; never inline item content here. New items get a file plus a row; completed items keep their file with the row marked DONE.

| Item | Status |
| --- | --- |
| [Detached generation bypasses pi's model runtime — Bedrock `Validation error`](backlog/bedrock-validation-error.md) | DONE 2026-09-13 (`96acd50`, registry-routed) |
| [`cacheRetention: "none"` on the detached generation call](backlog/cache-retention-none.md) | DONE 2026-09-13 (`96acd50`) |
| [Rehaul of handoff generation — agent-driven template + document-file tracking](backlog/handoff-template-rehaul.md) | DONE 2026-09-13 (slice A `e7aadbe`) |
| [All handoff styles emit the same template; `/continue` seeds the next session with previous-session linkage](backlog/unified-template-continue-linkage.md) | DONE 2026-09-13 (slice B `4e8e06a`) |
| [Command-path orphan `pendingAutoSubmit` — stray Enter into the new session](backlog/pending-autosubmit-orphan.md) | open — reassessed 2026-10-07: trigger path gone (W2), settle-gated + shutdown-cleared; close after one live warm-path check |
| [pi 1.0 extension-standards conformance — typebox peer, `agent_settled`, shutdown cleanup, tool exposure/annotations, dev pins](design/2026-10-07-pi-1.0-conformance.md) | DONE 2026-10-07 (branch `chore/pi-1.0-conformance`, merge-ready) |
| [Fast-path detached generation — tiered payload pipeline](backlog/fast-path-payload-pipeline.md) | open — idea |
| [Skip-list for tool calls in session-JSONL parsing (mempalace, Jira writes)](backlog/skip-tool-calls-serialization.md) | DONE 2026-09-13 (slice C `91585a0`) |
| [`handoff.effort` unmapped on anthropic-direct after the registry migration](backlog/effort-anthropic-direct.md) | open — documented limitation, zero current impact |
| [Own compaction extension — `pi-compact/`](backlog/pi-compact-extension.md) | open — idea |
| [pi-cache-window — idle prompt-cache countdown + cold-resume advisor](backlog/pi-cache-window.md) | planned 2026-09-11 — parked by owner |
| [Detached payload size — does the cold path still earn its keep?](backlog/detached-payload-size.md) | parked 2026-09-13 |
| [No-doc rehaul — filled template injected directly, no document files](design/2026-09-13-no-doc-rehaul.md) | DONE 2026-09-13 (live direction; W1 `97418d9`, W2 `d846274`) |
| [Cost tracking for summarization — `cost.jsonl`](backlog/cost-tracking-cost-jsonl.md) | parked 2026-09-02 |
| [In-session handoff mode — `handoff.type: "in-session"`](backlog/in-session-handoff-mode.md) | superseded 2026-09-12 |

Split from root `BACKLOG.md` on 2026-09-13.
