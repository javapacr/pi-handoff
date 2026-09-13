# Fast-path detached generation — tiered payload pipeline (compact-fast / ultra-compact techniques)

**Status:** open, idea (2026-09-13). Researched against two prior-art
extensions; absorbs the levers of [cache-retention-none.md](cache-retention-none.md) and [detached-payload-size.md](detached-payload-size.md) (which remain
separately-shippable slices).

### Prior art (verified)

- **@adamjen/pi-compact-fast** (`/compact-fast`,
  github.com/adamjen/pi-compact-fast) — "fast mode": hooks
  `session_before_compact`, calls a configured cheap model via
  `completeSimple()`, mirrors pi's native prompt, passes the prior summary for
  incremental updates, parallel dual summaries on split turns.
- **pi-ultra-compact** (github.com/ZachDreamZ/pi-ultra-compact) — "ultra
  mode": generational tiers — *micro*-compaction (regex strips reasoning +
  bulk tool outputs, **no LLM**) vs full compaction (graduated eviction L1–4);
  preemptive token watermark; snapshot-rollback + circuit breaker (3 failures
  → lossy fallback); cache-aware immutable summary blocks.
- **pi native compaction** (`packages/coding-agent/docs/compaction.md`) — the
  reference mechanism: delta summarization is native (prior summary passed as
  `<previous-summary>`, UPDATE prompt variant, re-slice at
  `firstKeptEntryId`); tool results truncated to 2000 chars during
  serialization; mechanical `readFiles`/`modifiedFiles` extraction before the
  LLM; one-off summarize prompts deliberately skip prompt-cache writes.

Neither exact name is published (registry-verified) — treat "fast" / "ultra"
as target concepts; the two repos are the concrete implementations.

### Cold-path cost anatomy (this repo, verified)

- Payload = **full transcript re-serialized, user/assistant text uncapped**
  (`session-adapter.ts:156-169`; only tool results hit pi's 2000-char cap
  inside `serializeConversation`) — the first-order cost the payload-size
  entry names.
- Gate + gather **walk the full branch twice** (`hasHandoffableConversation`
  `session-adapter.ts:141-152`, then `buildHandoffContext` `:154-173`).
- Diary pre-flight **blocks gather** behind `waitForIdle()` up to 120 s
  (`diary-reminder.ts:43`, `handoff-executor.ts:208-230`) — user-facing
  latency before the LLM call even starts.
- Git context = **5 sequential `execSync` per repo** (`git-client.ts:45-54`),
  no parallelism, no caching.
- No context caching between invocations; `cacheRetention` default `"short"`
  writes an unread cache point (see [cache-retention-none.md](cache-retention-none.md)).
- Model tiering already exists (`provider`/`model`/`effort`,
  `prompt-generator.ts:80-105`); personal profile already runs a flash model
  at low effort — the compact-fast *model* half is configured, the *payload*
  half is missing entirely.

### Design sketch — three levers + flow fixes (composable, each config-gated)

- **L1 — budgeted + delta payload** (operationalizes [detached-payload-size.md](detached-payload-size.md);
  pairs with [cache-retention-none.md](cache-retention-none.md)):
  - Tail-budgeted serialization, symmetric to pi's tool-result cap:
    `handoff.payloadBudgetChars` caps user/assistant text, head dropped,
    boundary never mid-turn.
  - Delta mode: mark the session at each handoff (hidden custom entry — the
    `handoff-origin` pattern); next `/handoff` summarizes only entries after
    the mark, prior doc passed as `<previous-summary>` (pi's UPDATE pattern).
    Boundary = max(last handoff mark, last compaction `firstKeptEntryId`) —
    `getHandoffMessages` (`session-adapter.ts:20-49`) already re-slices around
    compaction, so delta composes with it. `handoff.deltaMode: "auto"|"off"`.
- **L2 — mechanical pre-reduction** (ultra-compact micro tier, no LLM): strip
  thinking blocks; collapse tool outputs past the cap to one-line stubs with
  counts; assemble the doc skeleton from already-mechanical inputs (git
  state, todos, skills, usage — `context-gatherer.ts` has all of it) so the
  LLM writes only the narrative sections. Never drop user messages — the
  goal lives there.
- **L3 — profile presets** (compact-fast analog):
  `handoff.profile: "fast" | "quality"` — fast = flash-tier model + low
  effort + payload budget + delta on + `cacheRetention: "none"`; explicit
  `provider`/`model`/`effort` keys still win. Routing precedent:
  github.com/JMHSV/pi-compaction-model.

**Flow quick wins** (no config surface): merge the cheap gate into gather
(single branch walk); git execs → async + `Promise.all`; overlap the diary
reminder with gather instead of gating gather behind its `waitForIdle()` (the
two touch disjoint inputs); ship `cost.jsonl` ([cost-tracking-cost-jsonl.md](cost-tracking-cost-jsonl.md)) in the
same change — it is the measurement harness for everything above.

**Safety rails** (from ultra-compact): payload snapshot + extend the existing
model-fallback loop to "retry with larger budget / active model"; circuit-break
delta mode after repeated degenerate docs (missing `## Next Task`); the
mechanical skeleton must keep the doc contract byte-compatible — `## Next
Task` validation is load-bearing in `/continue` and the `continue` tool.

### Acceptance criteria

- `cost.jsonl` A/B on a representative long session: fast profile vs current
  defaults shows large reductions in `conversationChars` and `durationMs`
  (targets set at planning; baseline first).
- Smoke suite green + new checks: budget cap applied, delta boundary honored,
  `cacheRetention` forwarded, skeleton keeps the doc contract.
- Zero behavior change when no `handoff.profile`/`payloadBudgetChars`/
  `deltaMode` keys are set — opt-in until the A/B evidence is in.

### Open questions

- Delta mark: hidden session entry (entry-id precise, survives restarts) vs
  doc-timestamp heuristic (zero session writes) — entry preferred.
- Does L2 stub-collapse hurt doc quality on tool-heavy sessions? Judge via
  `cost.jsonl` + doc diff, not vibes.
- Default-on timeline: opt-in profile first; flip the default only after A/B.
- Interplay with [detached-payload-size.md](detached-payload-size.md)'s "should the cold path exist at
  all": L1+L2 may make the cold path cheap enough that the middle path
  (JSONL consumption) is moot — decide at planning with numbers.

### Sources

github.com/adamjen/pi-compact-fast · github.com/ZachDreamZ/pi-ultra-compact ·
github.com/earendil-works/pi `packages/coding-agent/docs/compaction.md` ·
github.com/JMHSV/pi-compaction-model · npm registry API (existence verdicts).

