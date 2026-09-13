# `cacheRetention: "none"` on the detached generation call

**Status:** open, needs planning (2026-09-12)

The detached `/handoff` call is one-shot: one system prompt, one
serialized-transcript payload, one response, and nothing ever reads the
resulting prefix. `CacheRetention = "none" | "short" | "long"`
(`pi-ai/dist/types.d.ts`), default `"short"` — so today the call writes a
Bedrock/Anthropic cache point. Cache **writes bill at 1.25× base input** (2× at
1h TTL); reads are 0.1×. With no reader, the write premium is pure waste on the
dominant cost line (the transcript is most of the call).

The Bedrock adapter gates on it explicitly:

```js
if (cacheRetention !== "none" && supportsPromptCaching(model, env) && result.length > 0) {
    lastMessage.content.push({ cachePoint: { type: CachePointType.DEFAULT,
        ...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}) } });
}
```

Break-even is on re-runs inside the 5-minute TTL:

| `/handoff` calls | caching on | caching off |
| --- | --- | --- |
| 1 | 1.25× | **1.00×** |
| 2 | **1.35×** (1.25 + 0.10) | 2.00× |

**Open question for planning:** how often is `/handoff` actually re-run (doc
missed something, user changed their mind)? Genuinely fire-once → `"none"` wins.
Re-run-prone → the default already pays for itself on the second call.

### Constraints

- **Detached path only — never global.** The warm path's entire economic
  argument is caching; `skills/pi-handoff/SKILL.md` states it: *"The session's
  history is already in the model's prompt cache, so generating the document
  here is the cheap path."*
- No billable effect in the personal profile: DeepSeek/Z.ai cache server-side
  automatically, so dropping pi's explicit cache point changes nothing there.
  This is a Bedrock/Anthropic-shaped win.
- The model-fallback loop is irrelevant either way — two different models, no
  shared cache.
- Slots into the same call site as the entry above (one option on one call).
  Hardcode `"none"` unless per-profile tunability is wanted
  (`handoff.cacheRetention`).

### Notes

- Second-order only: it does not shrink the payload. See [detached-payload-size.md](detached-payload-size.md) for the
  first-order levers.

