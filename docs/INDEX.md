# pi-handoff docs index

Cursor: `main @ 46c2e83` — the repo state this index describes.

Usage, config, and architecture live in [`../README.md`](../README.md); the shipped skill is [`../skills/pi-handoff/SKILL.md`](../skills/pi-handoff/SKILL.md).

## docs/

- [backlog.md](backlog.md) — backlog status board; one row per item in `backlog/`.

## docs/design/

- [2026-09-13-template-unification.md](design/2026-09-13-template-unification.md) — template unification: three backlog items, one handoff-document contract.
- [2026-09-13-no-doc-rehaul.md](design/2026-09-13-no-doc-rehaul.md) — no-doc rehaul: warm path passes the filled template inline, cold path launches directly.
- [2026-10-07-pi-1.0-conformance.md](design/2026-10-07-pi-1.0-conformance.md) — pi 1.0 conformance: typebox peer, `agent_settled` auto-submit, shutdown cleanup, `continue` exposure/annotations, dev pins.

## docs/backlog/

- [bedrock-validation-error.md](backlog/bedrock-validation-error.md) — detached generation bypasses pi's model runtime (Bedrock `Validation error`).
- [cache-retention-none.md](backlog/cache-retention-none.md) — `cacheRetention: "none"` on the detached generation call.
- [cost-tracking-cost-jsonl.md](backlog/cost-tracking-cost-jsonl.md) — cost tracking for summarization (`cost.jsonl`).
- [detached-payload-size.md](backlog/detached-payload-size.md) — whether the cold path's detached payload still earns its keep.
- [effort-anthropic-direct.md](backlog/effort-anthropic-direct.md) — `handoff.effort` unmapped on anthropic-direct.
- [fast-path-payload-pipeline.md](backlog/fast-path-payload-pipeline.md) — tiered payload pipeline for fast detached generation.
- [handoff-template-rehaul.md](backlog/handoff-template-rehaul.md) — agent-driven template-based generation rehaul.
- [in-session-handoff-mode.md](backlog/in-session-handoff-mode.md) — `handoff.type: "in-session"` mode.
- [pending-autosubmit-orphan.md](backlog/pending-autosubmit-orphan.md) — orphan `pendingAutoSubmit` stray Enter; reassessed after pi 1.0 conformance.
- [pi-cache-window.md](backlog/pi-cache-window.md) — idle prompt-cache countdown + cold-resume advisor idea.
- [pi-compact-extension.md](backlog/pi-compact-extension.md) — own compaction extension via `session_before_compact`.
- [skip-tool-calls-serialization.md](backlog/skip-tool-calls-serialization.md) — skip-list for tool calls in session-JSONL parsing.
- [unified-template-continue-linkage.md](backlog/unified-template-continue-linkage.md) — one template for all handoff styles; `/continue` previous-session linkage.
