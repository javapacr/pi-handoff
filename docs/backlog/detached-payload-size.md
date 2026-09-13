# Detached payload size — does the cold path still earn its keep?

**Status:** open, design question (2026-09-12)

`cacheRetention` is a 1.25× optimisation. It does not touch the fact that the
detached call re-sends the **entire conversation** as a fresh prefix on every
invocation. If `/handoff` cost is the real concern, the first-order levers are
(a) not re-sending the whole transcript, or (b) not having a cold path at all.

The original cost rationale for the warm path is recorded in the superseded
[in-session-handoff-mode.md](in-session-handoff-mode.md): generating the doc as a turn in the
dying session rides the session's own prompt-cache reads (~$0.30/M vs $3/M),
≈3–5× cheaper than the detached serialized path, with no prefix-replication
fragility and no TTL guessing.

Worth revisiting now that the detached path has demonstrated it cannot be
trusted with provider plumbing ([bedrock-validation-error.md](bedrock-validation-error.md)):

- Should `/handoff` inject an instruction turn into the live session — the
  removed in-session flow?
- Or should the two paths converge, with the detached call reserved for the
  genuinely-cold case the skill already names ("cold session, or a context that
  has grown very long")?
- Is there a middle path — e.g. having the detached call consume the session
  JSONL rather than a re-serialized transcript?

Out of scope for [cache-retention-none.md](cache-retention-none.md) and [bedrock-validation-error.md](bedrock-validation-error.md); noted so the planning pass sees the
whole shape.

