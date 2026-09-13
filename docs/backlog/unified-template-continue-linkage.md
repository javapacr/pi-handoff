# All handoff styles emit the same template — `/continue` seeds the next session with previous-session linkage

**Status:** DONE 2026-09-13 — implemented (slice B, `4e8e06a`); design in [design doc](../design/2026-09-13-template-unification.md), decisions D7–D8

Owner direction: whatever surface produces a handoff, the output is **the
same template** (defined in
[handoff-template-rehaul.md](handoff-template-rehaul.md)). The doc is
passed to `/continue` to send to the next session, **along with the
linkage of the previous session**.

### Shape

- One template, every style — detached `/handoff` generation and every
  other handoff path produce compatible docs; no per-surface formats.
- `/continue` receives the doc + **previous-session linkage**: enough to
  reference the prior session back (session id, profile, session-JSONL
  path) so the new session can consult the original transcript when the
  doc alone is not enough.

### Open questions

- Linkage format: bare session id, `~/.pi/<profile>/sessions/…jsonl`
  path, or both. Does `/continue` validate the link still exists?
- How the linkage reaches the new session: header in the doc, `/continue`
  argument, or both (doc header for humans, argument for the tool).
- The linkage must survive manual edits to the doc — users edit handoff
  docs.
- Interplay with the unified-flow surfaces (`/handoff`,
  `request_handoff`, `/continue`, `continue` tool) that already register
  in-session ([in-session-handoff-mode.md](in-session-handoff-mode.md)
  records that unification).

### Resolution (2026-09-13 design pass — [design doc](../design/2026-09-13-template-unification.md))

- **Linkage format (D8):** the existing hidden `handoff-origin` entry is the
  authoritative record, enriched with `profile` (from `PI_CODING_AGENT_DIR`);
  `parentSession` (session-JSONL path) is already the identity proxy — no
  session-uuid API exists. Link existence is never validated (deleted parent
  JSONL must not block launch — the doc is primary).
- **Delivery (D8):** both — a machine-stamped provenance header at byte line 1
  of the doc (humans + the next session's agent read it; no parser touches
  it) AND the enriched origin entry (machine record). The live first message
  is byte-identical to today's.
- **Manual-edit survival (D8):** by construction — the machine record never
  depends on the doc; the header is stamped only at the two creation surfaces
  (executor save; `continue` tool, atomic + idempotent) and **`/continue`
  never writes** (kills bare-path misattribution + TOCTOU clobber). A deleted
  header is an accepted cosmetic loss.
- **Unified emission (D7):** one versioned constant + test-enforced skill
  mirror + one validator at three uniform points — holds by construction, no
  per-surface format code. Bonus fix shipped in slice B: the `session_start`
  "↩ Continued" notify never fires today (entry-type mismatch — the lookup
  filters `type: "custom"` but the origin is a `type: "message"` custom
  *message*); slice B fixes the lookup and reads `message.details`.
