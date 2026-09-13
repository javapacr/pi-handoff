# In-session handoff mode — `handoff.type: "in-session"`

**Status:** SUPERSEDED 2026-09-12 — the unified flow removed the toggle entirely:
`handoff.type` is parsed for backward compatibility and IGNORED, and all four
surfaces (`/handoff`, `request_handoff`, `/continue`, `continue`) register in
every session. The `/handoff` executor no longer replaces the session — it
stages `/continue <docPath>` — so the "two clean registrations, selected by
toggle" split described below no longer exists. Entry kept for its rationale,
not as a live design. Originally implemented 2026-09-02.

**Addendum (2026-09-12, later the same day):** `request_handoff` removed
(user decision) — redundant with the `continue` tool (the agent writes the
document itself per the shipped skill) plus user-typed `/handoff` for the cold
path. Three surfaces register in every session: `/handoff`, `/continue`,
`continue`.

Motivation: when the summarizer IS the
session model (e.g. Sonnet-only work profile), generating the handoff doc as a
turn inside the dying session hits Anthropic prompt-cache reads (~$0.30/M vs
$3/M) — ≈3–5× cheaper than the detached serialized path, with zero quality
compromise. The session's own next turn IS the cache-aligned call by
construction: no prefix-replication fragility, no TTL guessing.

### Config

`settings.json` → `handoff.type: "detached" (default) | "in-session"`. Loaded at
extension startup by `config-repository.ts`; toggle requires session restart
(config does not hot-reload).

### Registration shape (two clean registrations, selected by toggle)

```ts
export default function handoffExtension(pi: ExtensionAPI): void {
 registerHandoffEvents(pi);
 const settings = loadHandoffSettings();
 if (settings?.type === "in-session") {
  registerHandoffCommandInSession(pi, settings);
  registerRequestHandoffTool(pi, { mode: "in-session" });
 } else {
  registerHandoffCommandDetached(pi, settings); // current executor path, untouched
  registerRequestHandoffTool(pi, { mode: "detached" });
 }
}
```

No mode-branching inside handlers — each registration owns one flow.
`request_handoff` (TUI prefill of `/handoff <goal>`) stays mode-agnostic in
mechanics (it just types the command); the registered command handler dispatches
per mode.

### In-session flow

1. `/handoff [goal]` → inject one instruction turn into the LIVE session
   (extension user-message API): "produce the handoff document for this session
   following exactly this template … write it to
   `$PI_CODING_AGENT_DIR/data/pi-handoff/handoff-<timestamp>.md` … then call
   `handoff_launch`." Goal embedded when given; redaction rules included.
2. The live agent generates the doc (warm cache: full history at cache-read
   rates) and writes the file.
3. Agent calls the **`handoff_launch`** tool (registered only in in-session
   mode). Tool: parses `## Next Task` from the doc, prefills the TUI with the
   new-session launch command — same prefill/terminal-strategy the detached
   flow uses ("put the command in the tui like earlier"). User presses enter →
   new session starts with the Next Task.
4. Template contract: the instruction embeds the SAME output template as
   `buildSystemPrompt` (extract from shared constant). `handoff_launch`
   validates `## Next Task` exists before prefilling; on failure, tool result
   tells the agent to repair the doc (self-healing loop).

### Implementation notes (2026-09-02, redesign same day after live probe)

- **`continue` redesign** (user-directed, after watching the herdr probe):
  the generation tool is `continue` (was `handoff_launch`) and the launch
  command is `/continue [docPath]` (was `/handoff-launch`). The **shipped
  `pi-handoff` skill** (manifest `pi.skills`) is now the PRIMARY instruction
  source — flow, document contract, exact template, `continue` usage. The
  injected instruction turn is deliberately THIN: goal, skill path (resolved
  from the module location so it works in the git-store clone), redaction
  safety net, file discipline, `continue` handoff, stop discipline. The
  template no longer rides in the instruction.
- The continuation prompt's `## Phase Adherence` is CANONICAL extension-owned
  text (`HANDOFF_PHASE_ADHERENCE`): `buildContinuationPrompt` strips any
  model-authored trailing section and appends the standard paragraph. Rationale:
  the live probe caught a model-authored Phase Adherence variant leaking extra
  directives ("route through CLASSIFICATION → VERIFICATION…") into the next
  session's first prompt, plus the next session then started doing handoff-meta
  work — the Next Task framing rule ("actual work, never handoff meta") and the
  canonical PA both counter this.
- The "new-session launch command" the tool prefills is `/continue <docPath>`
  (in-session mode only) — a literal `pi` CLI invocation cannot work: Enter in
  the TUI sends to the CURRENT session; only an internal command can create
  the new session in-process. It reuses the exact detached session-creation
  path (`createHandoffSession`, extracted to `application/session-creator.ts`).
- Shared constants live in `domain/handoff-template.ts`
  (`HANDOFF_CRITICAL_RULES`, `HANDOFF_OUTPUT_TEMPLATE`, `HANDOFF_PHASE_ADHERENCE`,
  `handoffGoalBlock`); the detached `buildSystemPrompt` output is byte-identical
  to pre-extraction (re-verified after the PA refactor). The skill's template
  block mirrors `HANDOFF_OUTPUT_TEMPLATE` — keep in sync.
- No compaction suggestion on this path (unlike detached): compacting first
  would replace the warm full-history prefix that makes the mode cheap.
- Diary reminder is folded into the injected instruction (one turn) instead
  of a separate pre-flight turn; still gated by `handoff.diaryReminder` and
  `mempalace_diary_write` tool presence.

- **Doc reference instead of pre-load** (2026-09-02, user): the new session
  is seeded with the document PATH + a read-first instruction, not the doc
  content — docs can be large and the content is pulled from disk on demand.
  `createHandoffSession` no longer takes `contextBlock`.
- **Generic `/continue`** (2026-09-02, user): `/continue <text>` (non-path)
  sends the text AS-IS to a new session — no handoff machinery — so the
  command doubles as a general "continue in a fresh session" tool.
  Disambiguation between a docPath and literal text is existence-based.
- `/handoff` and `request_handoff` removed from the in-session branch
  (2026-09-02, user — the skill makes the command redundant: the user asks
  the LLM directly and the agent follows the skill). Detached mode keeps
  both unchanged.

### Known limitations (reviewed 2026-09-02, oracle pass — non-blocking)

- The original goal is not threaded through `handoff_launch` →
  `/handoff-launch` → `createHandoffSession`, so in-session origin markers
  and completion events carry `goal: null` (the goal lives inside the doc's
  Context section). Cosmetic.
- If the in-session generation fails (agent never calls `handoff_launch`),
  no `handoff_command_complete` fires — failure is only visible as the turn
  ending without a prefill. `handoff_launch` also emits no
  `handoff_tool_start/end` (those channels are documented as
  `request_handoff`-specific).
- Parser divergence on degenerate docs: `findNextTaskSection` is
  heading-anchored, `splitHandoffPrompt` splits on the `"\n## Next Task"`
  substring — docs with the heading as the very first line, or a
  `"## Next Task extra"` line after a real heading, can split differently.
  Left alone deliberately: making `splitHandoffPrompt` heading-strict would
  change detached near-miss-heading behavior ("## Next Task: …"), and the
  detached path must stay untouched. Template-produced docs are unaffected.

### Notes

- Cost capture for this mode comes free: the doc-generating turn's assistant
  message in the session JSONL carries `usage` (incl. cacheReadTokens) — feeds
  cost.jsonl without a separate API call.
- The detached path's thinking-cap trim matters only on the detached path;
  cache reads make raw prefix size nearly free here.
- Edge cases: goal-less invocation (instruction says infer next task); user
  cancels mid-generation (nothing prefilled — harmless); session model ≠
  Anthropic (still works — DeepSeek auto-cache hits the same way; non-caching
  providers just pay normal rates).

