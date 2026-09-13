# pi-cache-window — idle prompt-cache countdown + cold-resume advisor

**Status:** PLANNED 2026-09-11 — scoped, design complete, parked by owner.
Full plan: `~/.pi/plans/Users-reevonr-Documents-projects-personal/2026-09-11/pi-cache-window-extension.md`.
API surface scout-verified against pi `types.d.ts` same day. New standalone
extension (`pi-extensions/pi-cache-window/`), not pi-handoff work — stored
here as the owner's idea backlog.

**Problem:** with multiple agents in herdr, an idle session that crosses the
provider's 5-minute prompt-cache window silently turns its next prompt into a
full-price context re-read. Need at-a-glance warm/cold per idle agent and a
decide-not-maintain flow: warm → continue session; cold → `/compact` or
pi-handoff to a fresh session.

**Scope decisions (owner, 2026-09-11):** bedrock-anthropic / anthropic, 5m
TTL only (`ttlSeconds` default 295). Keepalive OUT — at 5m the economics are
a wash (≈1.2x input/hr idle keepalive vs 1.25x one-time re-write); if
keep-warm is ever wanted, `pi-idle-time`'s opt-in heartbeat already covers it.

**Design:** pure state machine `ACTIVE → WARM(countdown) → COLD`, reset on
`input`/`agent_start`/`turn_start`; one 1s `setInterval` (`.unref()`), tick
gated on `ctx.isIdle()`, cleared on `session_shutdown`. Statusline segment
via `ctx.ui.setStatus("cache-window", …)`: `🔥 3:42` → `⚠️ 0:58` →
`❄️ cold +2m`. COLD crossing → `ctx.ui.notify(…, "warning")` with cost
estimate (`ctx.getContextUsage().tokens × ctx.model.cost.input`); first
resume while COLD → one-shot advisory toast (continue vs /compact vs
pi-handoff); never blocks, never auto-compacts. Commands:
`/cache-window [on|off|ttl <s>|title on|off|compact]` — `compact` calls
`ctx.compact()` directly. Optional terminal-title prefix off by default (no
other installed extension writes titles — verified).

**Provider gate:** `ctx.model.provider ∈ {bedrock-anthropic, anthropic}` on
`session_start`/`model_select`, else extension inert. Config: `config.json`
next to the extension `{ ttlSeconds, enabled, showTitle, providers }`.

**API (types.d.ts confirmed):** `pi.on(session_start|input|agent_start|
turn_start|agent_end|model_select|session_shutdown)` · `ctx.isIdle()` ·
`ctx.ui.{setStatus,setTitle,notify}` · `ctx.getContextUsage()` →
`{tokens,contextWindow,percent}` · `ctx.model.{provider,id,cost.*}` ·
`ctx.compact({customInstructions?,onComplete?,onError?})` ·
`pi.registerCommand(name,{description?,handler})`. NB `agent_end` carries NO
usage payload (types.d.ts:469-471) — estimates come from getContextUsage +
model.cost.

**Landscape (why build; surveyed 2026-09-11):** pi-idle (title ✓/spinner,
frozen since May) · pi-idle-time (idle timer statusline + Anthropic 5m
heartbeat, opt-in) · pi-kimi-keepalive (endpoint byte-replay — impossible on
Bedrock: SigV4 signatures expire ≤5–15 min, would need re-signed requests) ·
pi-cache-guardian (prefix stabilization, golden freeze) · @narumitw/
pi-statusline (cache segment display) · pi-cache-insight/graph (post-hoc
analytics) · Claude-Cache-Countdown (Claude Code external ticker — the UX
template: 🟢→🟡→🔴→❄️, cost-at-risk, bells). Nobody does countdown +
cold-resume decide flow wired to compact/handoff. TTL facts: Anthropic/Bedrock
5m default (write 1.25x, read 0.1x; 1h optional 2x write), OpenAI 5–10m
in-memory (GPT-5.6+: 30m retention), DeepSeek disk cache hours–days (no-op),
Kimi ~5m nominal, measured longer; all best-effort — UI must say "likely
warm", never guarantee.

**Verification gate:** vitest green on the pure state machine + formatting ·
`tsc --noEmit` · `pi -e ./index.ts` smoke with `ttl 15`: observe WARM
countdown → COLD toast → resume advisory → `/cache-window compact` ·
fresh-session install check (manifest `pi.extensions` string array only, per
monorepo gates above).
