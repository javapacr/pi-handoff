# Skip-list for tool calls in session-JSONL parsing — drop side-channel rewrite noise (mempalace, Jira writes)

**Status:** DONE 2026-09-13 — implemented (slice C, `91585a0`); design in [design doc](../design/2026-09-13-template-unification.md), decision D9

Owner direction: the session-JSONL → serialized-conversation parsing can
**skip selected tool calls** that add no handoff value. First named
candidate: **mempalace diary writes** — a pure memory rewrite: post-hoc
summaries of content that is already in the session verbatim.

### The test: does the call's *result* inject external state?

Generalized beyond mempalace (owner direction 2026-09-13, Jira follow-up):
**keep any call whose result injects information that exists nowhere else
in the session; stub the rest.**

- **Skip (stub):** mempalace `diary_write` (and `reconnect`) — post-hoc
  re-encodings of session content; and **write-side Jira calls**
  (`pi-atlassian` comment / update / transition) — their *input* is
  agent-composed from session context, their *output* is only a mutation
  receipt. The side effect itself ("commented on CVP-1234, transitioned
  to Done") belongs in the handoff narrative; the stub carries the fact.
- **Keep:** mempalace *search/recall* results and **read-side Jira calls**
  (issue fetch, JQL search) — both inject **external-system state not
  derivable from this session** (other people's comments, ticket fields,
  sprint context, cross-session memory); dropping them silently loses
  context the agent actually used.
- Complements [fast-path-payload-pipeline.md](fast-path-payload-pipeline.md)
  L2 (mechanical pre-reduction): the stub-collapse lever there needs a
  policy for *which* calls to drop; this item is that policy, separately
  shippable.

### Design sketch

- `handoff.skipTools`: list of tool-name patterns, defaulting to the
  mempalace diary tools + `pi-atlassian` write calls (exact name forms in
  the JSONL — direct MCP tool names vs `mcp`-gateway invocations — to be
  verified at implementation).
- Prefer a **one-line stub** over silent deletion (tool name +
  "skipped"): keeps turn order coherent, mirrors ultra-compact's
  stub-collapse.
- Payload note: tool results are already capped at 2000 chars inside
  `serializeConversation`, so the primary win is **noise reduction** for
  the generator, with a smaller payload on tool-heavy sessions.

### Open questions

- Default list: mempalace diary tools + `pi-atlassian` writes. Further
  candidates (`lens_diagnostic_mark`, `todo` updates) each get the same
  external-state test.
- Stub vs full drop — decide via doc-quality diff, not intuition.

### Resolution (2026-09-13 design pass — [design doc](../design/2026-09-13-template-unification.md))

- **Config (D9):** `handoff.skipTools: string[]`, single-token `*` glob
  (zero-or-more chars, case-sensitive), matched against tool-call
  `block.name` AND `toolResult.toolName`. User list **replaces** defaults;
  `[]` disables; malformed value (non-array / non-string entry) → ignored +
  one-line notify. `tool-skip.ts` self-loads settings — no signature changes.
- **Defaults (verified):** `*mempalace_diary_write`, `*mempalace_reconnect`
  (plain + server-prefixed direct forms), `jira_assign_ticket`,
  `jira_update_status` (pi-atlassian's only writes, verified from source —
  reads kept). Default ON. `lens_diagnostic_mark` / `todo` NOT defaulted —
  each needs its own external-state-test decision.
- **Stub vs drop (D9):** stub — drop the matched assistant `toolCall` block
  (its args are the noise), replace `toolResult.content` with one line
  `[skipped by handoff.skipTools: <toolName>]`, touching `content` only and
  never `details` (protects `extractTodos` by invariant). Hard rule:
  **clone-before-mutate** — `getHandoffMessages` returns live branch objects
  by reference. The doc-quality diff stays a slice-C smoke/verification
  obligation (turn-order coherence + no-mutation checks are specified);
  real-session doc diffs judge the `lens_diagnostic_mark`/`todo` candidates
  later.
- **Placement:** pre-filter on the `AgentMessage[]` in `buildConversationText`
  before upstream `serializeConversation` (not patchable). Gateway-form
  invocations (`mcp` + target in arguments) deferred to fast-path L2.
