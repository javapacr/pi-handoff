# Own compaction extension — `pi-compact/` (fast-model summarizer via `session_before_compact`)

**Status:** open, idea (2026-09-13). **Separate extension repo** in the
monorepo — not a pi-handoff change. Complements [fast-path-payload-pipeline.md](fast-path-payload-pipeline.md):
`getHandoffMessages` (`session-adapter.ts:20-49`) re-slices around whatever
compaction entries exist, so a fast `/compact` shrinks every future `/handoff`
payload for free.

### Core decision — `ctx.modelRegistry.complete()`, NOT `completeSimple()`

`completeSimple` (@earendil-works/pi-ai) = one-shot non-streaming completion:
model + `{systemPrompt, messages}` + `{apiKey, headers, maxTokens, signal}` →
structured `{content, stopReason, usage}`. It requires **hand-resolved auth**
(`getApiKeyAndHeaders`) — exactly the plumbing that produced the Bedrock
`Validation error` (entry above; `baseUrl`/`env` dropped → wrong region).
pi's official `custom-compaction.ts` example uses
`ctx.modelRegistry.complete(model, {messages}, {maxTokens, signal,
cacheRetention: "none", sessionId})` instead: registry owns auth/env/region,
and `cacheRetention: "none"` kills the 1.25× unread cache-write (same
economics as the cacheRetention entry — a summary call is one-shot). Prefer
the registry path.

### Core contract

`pi.on("session_before_compact")` → receives `preparation`
(`messagesToSummarize`, `turnPrefixMessages`, `isSplitTurn`, `tokensBefore`,
`firstKeptEntryId`, `previousSummary`, `fileOps`, `settings`) → returns
`{compaction: {summary, firstKeptEntryId, tokensBefore, details}}` or
`undefined` → **built-in compaction proceeds**. Fires for auto-compaction AND
manual `ctx.compact()`. Compaction must never brick a session: any failure →
`undefined` + notify.

### MVP checklist (mirror @adamjen/pi-compact-fast, ~250 lines)

1. The hook above; separately-named command (pi owns `/compact`) + flag so
   un-flagged compaction stays built-in (pi-compact-fast's `useFastModel`
   pattern).
2. Model from config — `compact: {provider, model}` in settings.json
   (pi-handoff `loadHandoffSettings` pattern); NOT hardcoded
   (pi-compact-fast hardcodes `qwen-35b-moe` in source). Missing model →
   notify + fall back.
3. pi's three native prompts verbatim — `SUMMARIZATION` / `UPDATE` (fires
   when `previousSummary` exists = incremental delta for free) /
   `TURN_PREFIX` (split turns). Conversation FIRST in `<conversation>` tags,
   instructions last. Format stability is load-bearing: pi-handoff injects
   `compactionSummary` verbatim into handoff generation.
4. `serializeConversation(convertToLlm(msgs))` input; dynamic budgets from
   `settings.reserveTokens` (0.8× history / 0.5× prefix).
5. Split turns: dual summaries (sequential, pi-native order — parallel
   optional) + merge separator.
6. `fileOps` → `<read-files>`/`<modified-files>` tags + `details` object
   (pi's internal tracking consumes it).
7. Guards: empty-conversation abort, `stopReason === "error"` check, signal
   honored.
8. `cacheRetention: "none"` on the call.

### Phase 2 — pi-ultra-compact candidates: REVIEWED 2026-09-13 — verdict 0/11 BUILD

Adversarial review (fresh-context devils-advocate) audited against
pi-ultra-compact's own source (`engine.ts`, `RESEARCH.md`,
`benchmark.test.ts`) and pi's compaction docs. Central finding: ultra-compact
is a **full-pipeline replacement** (own triggers, thresholds, safety nets,
fallbacks — its "LLM summarization" even truncates each message to 500 chars
before the call), while pi-compact is a **summarizer swap** inside pi's
machinery, which already provides trigger, cut points, budgets, file tracking,
append-only durability, and a fallback ladder. Importing its machinery = the
burdens without the benefits. Per-technique:

- **T1** mechanical micro-pass — SKIP (in-contract variant = the 2000-char
  serialization cap; live-rewrite variant = pi-condense's territory).
- **T2** graduated eviction L1–4 — SKIP (L1 strips the raw material for
  `## Key Decisions`; L4 **is** pi's cut-point walk).
- **T3** preemptive watermark — SKIP (pi already checks thresholds mid-run,
  before the next assistant response and before a new user prompt;
  zero-code replacement = raise `reserveTokens`).
- **T4** contextWindow-derived thresholds — ALREADY-FREE.
- **T5** snapshot-rollback — SKIP (sessions are append-only; compaction is a
  pointer entry, originals retained; "rollback" = ignore the entry — the
  deep-copy guards a mutation that cannot happen).
- **T6** circuit breaker → lossy truncation — SKIP (strictly worse output
  than the free native fallback; solves a problem only a no-fallback
  architecture has).
- **T7** user messages inviolable — ALREADY-FREE (pi cut-point rules +
  split-turn routing).
- **T8** cache-aware immutable summary blocks — SKIP (pennies on Sonnet,
  worthless on server-side-cached deepseek; the monotonic-prefix constraint
  makes summaries grow unboundedly; pi itself skips cache writes on one-off
  compaction calls).
- **T9** token-compressed language — SKIP (verified: regex article-stripping,
  not semantic density; breaks the pi-handoff verbatim `compactionSummary`
  injection contract).
- **T10** 3-pass entropy scoring + LRU cache — SKIP (3× the LLM cost the MVP
  exists to minimize; "entropy" is a keyword table + seen-Set; headline
  numbers appear nowhere in its own research or benchmarks).
- **T11** lost-in-the-middle ordering — SKIP (the summary sits at the FRONT
  of post-compaction context; claim unvalidated).

**Adopted instead — the only durable phase-2 value:**

1. **Summarizer-input overflow guard** (~20 lines, in-hook): if serialized
   input exceeds summarizer context − output budget, drop oldest content with
   an explicit `[older context truncated]` marker, preserve errors/decisions.
   Closes the one real tail risk: huge span → flash model fails → silent
   fallback to the session model (Sonnet-class on work profile = exactly the
   expense this extension exists to avoid).
2. **Per-compaction telemetry** (~15 lines): `{summarizerModel, usage,
   latencyMs, reason, isSplitTurn}` in `details` + a
   `session_compact_failed` listener. No independent benchmarks exist for ANY
   candidate technique (ultra-compact's included, our MVP's included) —
   measure our own and let data gate anything beyond this shortlist.
3. **Zero-code tuning**: raise `reserveTokens` per profile
   (`compaction.modelOverrides`); add one sentence to the UPDATE prompt
   preserving section order/names (pi-handoff stability insurance).

### Monorepo gates (pi-extension-authoring skill)

New `pi-compact/` repo; manifest `pi.extensions: ["./index.ts"]` — **string
array only** (object entries are silently dropped, extension never loads);
bare imports `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai`
resolve without dependencies; commit+push → `pi install git:...` per profile
→ `packages` entries; verify in a fresh interactive session (LAST
`[Extensions]` banner + one demonstrated behavior) + `tsc --noEmit` + smoke
suite (pi-handoff `test/` staged-stub harness is the template).

### Sources

github.com/adamjen/pi-compact-fast (`extensions/index.ts`, read in full) ·
github.com/earendil-works/pi `examples/extensions/custom-compaction.ts` (the
registry-call pattern) · [bedrock-validation-error.md](bedrock-validation-error.md) (auth lesson) ·
[cache-retention-none.md](cache-retention-none.md) (cacheRetention economics) ·
[fast-path-payload-pipeline.md](fast-path-payload-pipeline.md) (handoff fast path).

