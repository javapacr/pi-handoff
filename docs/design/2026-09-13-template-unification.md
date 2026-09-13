# Design — template unification (three backlog items, one contract)

**Date:** 2026-09-13 · **Items:** [handoff-template-rehaul](../backlog/handoff-template-rehaul.md) · [unified-template-continue-linkage](../backlog/unified-template-continue-linkage.md) · [skip-tool-calls-serialization](../backlog/skip-tool-calls-serialization.md)
**Provenance:** owner direction 2026-09-13; design pass reviewed adversarially (r2 — all findings applied; the notify-bug diagnosis re-verified in source).

**Scope:** resolve every open question across the three items as one design. **Non-goals:** the two approved `/handoff`-scoped fixes (`bedrock-validation-error`, `cache-retention-none` — they land *before* implementation of this design; entanglement is low: same file `prompt-generator.ts`, disjoint functions, and the smoke harness stubs the LLM); fast-path-payload-pipeline L2 (this supplies its policy half only); no new event/auto-submit surfaces.

**Verified facts baseline** (scout recon + adversarial re-verification, 2026-09-13; anchors are function-level — line numbers drift): single template constant `HANDOFF_OUTPUT_TEMPLATE` in `domain/handoff-template.ts`, consumed only by the detached `buildSystemPrompt`; the skill mirrors it by hand ("keep in sync" prose, no coupling); validator = `findNextTaskContent` (regex-anchored `## Next Task`, last-wins, ends at next `##`, non-empty) enforced at three points (executor `executeHandoff` post-save validation, `/continue` `launchFromDoc`, `continue` tool repair loop); `buildContinuationPrompt` live message embeds doc path + Next Task body + canonical Phase Adherence — nothing else; `createHandoffSession` writes the origin record via `sm.appendMessage({role: "custom", customType: "handoff-origin", …, details: {parentSession, goal, timestamp, docPath}})` — i.e. a **`type: "message"` entry with `message.role === "custom"`**, while the `session_start` lookup in `event-registration.ts` filters `e.type === "custom"` (a different entry shape whose payload field is `data`) — the predicates never match, so the "↩ Continued" notify **never fires today**; serialization is upstream-owned (`serializeConversation`, 2000-char tool-result cap, per-block emission — an assistant message emptied of all blocks renders nothing) so any skip-list must be a pre-filter on cloned `AgentMessage[]`; `getHandoffMessages` returns `entry.message` **by reference** into the live branch; git-client already fetches `status --short` per discovered repo (untracked **directories collapse** to `?? dir/` — files inside invisible without `--untracked-files=all`); config is an unvalidated passthrough (`loadHandoffSettings` → `parsed.handoff ?? null`); the smoke harness stages only the `.ts` tree (skills/ excluded today); the smoke suite = 63 checks incl. a byte-equality assertion on the saved artifact.

---

## D1 — Template: one versioned constant in code; skill sync enforced by test

**Decision.** The template stays a code constant in `domain/handoff-template.ts`, now explicitly versioned: `export const HANDOFF_TEMPLATE_VERSION = 2`. No config key, no runtime-loaded template file.

**Why.** The template is a product contract of the extension — it versions with the code and every consumer (system prompt, skill, validator, tests) ships in the same package. A config key or repo file would add a resolution + malformed-input failure surface through a config layer that today has no validation at all, in exchange for an override ability no one has asked for.

**Skill drift — the actual gap — closes mechanically.** `skills/pi-handoff/SKILL.md`'s fenced document-contract block must byte-equal the rendered `HANDOFF_OUTPUT_TEMPLATE`. A new smoke check extracts the fenced block and compares against the rendered constant; the prose "keep the two in sync" note is replaced by a test. Harness note: the staged tree must also carry `skills/` (or the check reads the original repo root passed via environment).

**Hygiene in the same slice.** Delete dead `splitHandoffPrompt` (zero callers; its marker semantics confuse the live validator). Fix the `handoff-template.ts` header comment that still names the deleted `commands/handoff-in-session.ts` as a consumer.

## D2 — Template = generation contract; validation stays minimal and version-independent

**Decision.** The doc-validation contract remains exactly what it is today: `findNextTaskContent`, byte-identical, at all three enforcement points. The template does NOT become the validator. No new hard validation for v2 sections.

**Why.** The template's own rule is "omit any section that has no content", and users hand-edit docs — full-template validation would false-reject legitimate documents and couple doc validity to template version. `## Next Task` is the only section a machine consumes (the new session's seeded instruction), so it is the only hard gate. Consequence: **template evolution never invalidates old docs.** (Verified both directions: a `<!-- … -->` line 1 and a `## Document Files` section are invisible to all three validators.)

## D3 — Template v2: `## Document Files` section + machine-stamped provenance header

Two additions (section order otherwise unchanged; `## Next Task` stays in place):

1. **`## Document Files`** between `## Git State` and `## Active Tasks`, omit-when-empty like every other section. Line format:
   `- <path> — <in-session|git-only> — <optional one-line what-it-is>`
   Path + provenance marker are mechanical; the trailing annotation is generator narrative and is **optional for git-only rows** (the generator may never have seen the file — do not invite hallucinated descriptions).
2. **Provenance header**, byte line 1 of the saved doc, **never model-authored** (the generator does not know its own session file):
   `<!-- pi-handoff v<N> | session: <absolute session-JSONL path> | saved: <ISO-8601> -->`
   Non-load-bearing: no parser reads it. Humans and the next session's agent (who read the doc first) see the linkage; the machine record is the origin entry (D8). The version token `v<N>` renders from `HANDOFF_TEMPLATE_VERSION` and is the only version stamp — the origin entry carries **no** `templateVersion` field (no consumer; add one when a consumer exists).

`HANDOFF_TEMPLATE_VERSION` bumps on any future section-set change.

## D4 — "Document file" definition: extension allowlist + path denylist

`DOCUMENT_EXTENSIONS = [".md", ".txt", ".rst", ".adoc"]`; denylist: `node_modules/`, `.git/`, `dist/`, `build/`, `$AGENT_DIR/tmp`, **and `$AGENT_DIR/data/pi-handoff`** (handoff docs themselves — including a retried `/handoff`'s predecessor doc — are reachable via `newestHandoffDocPath`, not doc-file-tracking material). Both are named constants in `domain/` — deliberately not config (rationale as D1). `.json`/`.yaml` excluded: config-shaped payloads, not documents a reader should read before continuing.

## D5 — Tracking sources: git status primary, session tool-log secondary, union with provenance

- **Primary — git status, already in hand, amended exec.** Change the per-repo status call to `git status --short --untracked-files=all` (**same exec count** — "zero new git execs" survives) so files inside not-yet-tracked directories appear individually — the uncollapsed form is the whole point: subagent/manual writes into new `docs/`, `plans/`, `backlog/` directories are precisely the freshly-created material a new session most needs. Filter modified + untracked + renamed lines through D4. **Parsing rules:** `R  old -> new` rows yield the **new** path; git C-quoted paths (special/non-ASCII chars) must be unquoted/escaped per git's `core.quotePath` convention before extension matching.
- **Secondary — session tool-log.** Scan the branch for `write`/`edit` tool calls (assistant `toolCall` blocks, keying on `block.name` + `arguments.path`, mirroring upstream compaction's `extractFileOpsFromMessage` shape) through the same allowlist. Catches non-git, non-denied documents written outside any repo. Note: `write` ≠ created (the tool overwrites) — provenance is therefore **`in-session` vs `git-only`**, not created/edited (unknowable from the log).
- **Union, dedupe by resolved path**; `in-session` wins as the marker when both sources hit.
- New extractor feeds `HandoffContext.documentFiles` → new `## Document Files` input section in the detached `buildUserPayload`.
- **Explicitly deferred (documented, not silently implicit):** `discoverReposFromConversation`'s one `git rev-parse` per unique conversation path (5 s cap each, unbounded count) rides along unchanged; submodule-internal doc changes surface as one modified-directory entry and are dropped. Both acceptable now; revisit with fast-path flow fixes.

## D6 — Which surface runs the generation pass: both existing ones, no new surface

- **Detached `/handoff`**: gatherer supplies the mechanical doc-file list into the payload; the LLM fills the v2 template (system prompt already embeds the constant — mechanism unchanged).
- **Warm skill path**: the skill instructs the agent to compute the same list under the same D4/D5 definition (its own write/edit calls + `git status --short --untracked-files=all` per repo) and write `## Document Files`. There is no injected turn to hand it a gathered list — the agent's own tool calls are its session log; one git call is cheap.
- **Sequencing dependency**: the work profile cannot exercise the detached path until `bedrock-validation-error` lands — prerequisite for *validating* this design end-to-end on `/handoff`, not for landing it (slice gates don't depend on the fix: the harness stubs the LLM).

## D7 — Unified emission across all styles

Two producers (detached LLM, warm skill agent), one consumer path (`/continue` → `createHandoffSession`). With D1+D3+D6: one versioned constant, one test-enforced skill mirror, one validator enforced at three uniform points. "All handoff styles emit the same template" holds **by construction** — no per-surface format code exists or is added.

## D8 — Previous-session linkage: extension-owned at creation surfaces; `/continue` never writes

- **Authoritative record = the existing hidden `handoff-origin` message entry**, enriched with exactly one field: `profile` (= `resolvePiAgentDir()` value; no profile API exists — `PI_CODING_AGENT_DIR` is the only signal the extension touches). `parentSession` (session-JSONL path) is already the identity proxy — no session-uuid API exists; the filename embeds timestamp + uuid.
- **Bug actually fixed in this item (re-diagnosed, confirmed in source):** the `session_start` lookup filters `e.type === "custom"`, but `createHandoffSession` appends via `sm.appendMessage({role: "custom", …})` — a `type: "message"` entry — so the predicate never matches and the "↩ Continued" notify never fires. Fix the lookup to match `e.type === "message" && e.message.role === "custom" && e.message.customType === "handoff-origin"` and read `e.message.details`. While there, surface `profile`/`parentSession` in the notify text (gives `profile` its consumer).
- **Header stamped at creation surfaces only:**
  - Detached: `saveHandoffArtifact` writes the stamped doc directly (fresh file — the stamp is simply part of the first write).
  - Warm: the `continue` tool, after its existing re-read + validation succeeds, prepends the header **if absent**, via **atomic write (tmp file + rename)**. The tool runs in the true parent session and is the agent's declared last action — the write window is minimal and rename precludes truncation. Stamp failure is non-blocking: notify-only, tool still succeeds (the header is cosmetic; the origin entry is the record).
  - **`/continue` performs no writes.** This drops the "/continue stamps" candidate outright: it would misattribute provenance on the bare path (`/continue` from an unrelated session launching the newest doc), clobber user-open files (read-modify-write TOCTOU), and risk post-validation truncation — a whole failure class removed by not writing at the launch path. Known limitation, pre-existing and unchanged: the bare-path origin entry also attributes to whatever session runs the command.
- **Live message: byte-identical.** `buildContinuationPrompt` is untouched. Agent-visible linkage = the stamped header in the doc it reads first; machine linkage = the origin entry. This is the "both" option from the item — doc header for humans/agent, hidden entry for the tool.
- **Manual-edit survival:** the machine record never depends on the doc (re-derived at launch inside `createHandoffSession` from live ctx). The header itself is *not* re-stamped if a user deletes it — accepted cosmetic loss.
- **Link existence: not validated.** A deleted/moved parent JSONL must not block launch — the doc is primary, linkage consultative.
- No new events, no new staging steps (auto-submit race surface untouched — cf. `pending-autosubmit-orphan`).

## D9 — `handoff.skipTools`: pre-serialization stub filter

- **Config.** `handoff.skipTools: string[]` — glob patterns matched against tool-call `block.name` AND `toolResult.toolName`. **Glob semantics, precisely:** a single `*` token matching zero-or-more characters, case-sensitive, no other metacharacters (so `*mempalace_diary_write` matches both `mempalace_diary_write` and `mempalace-personal_mempalace_diary_write` by definition, not by accident). **Validation (the one place this key touches the passthrough layer):** non-array value or any non-string entry → ignore the setting entirely + one-line notify. A user list **replaces** the defaults; `[]` disables. Defaults are a named exported constant, documented, so users copy-extend.
- **Defaults (names verified today).**
  - `*mempalace_diary_write`, `*mempalace_reconnect` — cover plain and server-prefixed direct forms. Recall/search and `diary_read` deliberately NOT matched (reads inject external state — kept).
  - `jira_assign_ticket`, `jira_update_status` — pi-atlassian's only write tools (verified from source; the other three are reads). Direct extension tools — no prefix variance.
- **Mechanism — clone before mutate (hard rule).** New `infrastructure/tool-skip.ts`, applied in `buildConversationText` on a **deep-cloned copy** of the `AgentMessage[]` **before** upstream `serializeConversation`. `getHandoffMessages` returns live branch objects by reference — in-place mutation would corrupt the session's in-memory branch for every later consumer (compaction, a second `/handoff`). For a matched call/result pair: **drop the assistant `toolCall` block** (its arguments are the noise — agent-composed re-encodings of session content) and **replace the `toolResult.content` with one line** — `[skipped by handoff.skipTools: <toolName>]` — **touching `content` only, never `details`**: `extractTodos` reads `details`, so even a user pattern matching `todo` results cannot break todo extraction, by stated invariant rather than accident. An assistant message emptied of all blocks renders nothing upstream (verified). Turn order stays coherent via the stub line.
- **Wiring:** `tool-skip.ts` self-loads settings via `loadHandoffSettings()` (fresh, per-use — the established pattern in `event-registration.ts`), keeping `buildConversationText`'s signature unchanged; settings flow nowhere new.
- **Policy.** The external-state test stays the documented admission rule (keep any call whose result injects information existing nowhere else in the session). `lens_diagnostic_mark` and `todo` are NOT defaulted — each gets its own future decision under the test.
- **Known limitation, deferred:** gateway-form invocations (tool name `mcp`, target inside `arguments`) match only if a pattern matches `mcp` itself — deliberately not in defaults (too broad). With `directTools` configured in both profiles, the named tools are direct-named in practice. Gateway argument-matching belongs to fast-path L2.
- **Default ON** (defaults active with no config present), per owner direction.

---

## Compatibility & migration

- **`## Next Task` contract: byte-compatible.** Validator untouched; live message untouched; canonical Phase Adherence untouched; verified both directions (old docs remain valid; v2 docs pass the *current* validators — header comment and `## Document Files` are invisible to them). **No doc migration needed.** One suite assertion updates: the smoke byte-equality check on the saved artifact becomes `stamp + "\n" + VALID_DOC` when slice B adds the save-stamp — listed here so the gate is never "fixed" by deleting an assertion.
- Doc naming scheme unchanged → `newestHandoffDocPath` filename-sort behavior unchanged.
- `handoff.skipTools` absent = defaults active; malformed = ignored + notify; `[]` = explicit off.

## Sequencing (implementation slices — separate sessions)

0. **Approved pair first (not this design):** `bedrock-validation-error` (preferred shape (b): route through `modelRegistry.complete`) + `cache-retention-none` — same detached call site; hard prerequisite for work-profile end-to-end validation of slices A/B; low code entanglement with this design.
1. **Slice A — template v2 + doc-file tracking** (template rehaul): version constant + v2 template + hygiene (dead code, header comment); doc-file extractor (allowlist/denylist, `--untracked-files=all` + rename/quote parsing) → gatherer field → payload section; skill v2 mirror; sync smoke check. Smoke: template/skill sync; document-file extraction matrix (incl. untracked-dir file, rename row, quoted path, denied paths); payload section presence.
2. **Slice B — linkage** (depends on A): origin-entry `profile` field; session_start lookup fix (entry-type + `details`) + notify text; executor save-stamp; `continue`-tool stamp (atomic, idempotent, non-blocking); `/continue` remains write-free. Smoke: origin fields; stamped save (updated byte-equality assertion); idempotent tool stamp; hand-edited doc still launches; notify fires from a correctly-typed origin entry.
3. **Slice C — skipTools** (independent of A/B; may land any time after 0): tool-skip module (clone-before-mutate, content-only stub) + config key + validation + hook + defaults. Smoke: default match/stub matrix; override-replaces; `[]` disables; malformed-setting ignored; turn-order coherence; non-matching (`todo`) untouched incl. `details` preservation; no mutation of live branch objects (same-session double-serialization check).

Gate per slice: full smoke suite green (63 checks today, grows per slice) in the self-staging harness; `test/smoke.ts` is the shared merge point for all slices — land serially.

## Out of scope / deferred

Fast-path L2 mechanical reduction (skipTools is its policy half) · gateway-argument matching · filtering the diary-reminder's injected user message (only its tool result stubs) · git-client conversation-scan cost + submodule blindness (D5) · bare-path origin misattribution (pre-existing).
