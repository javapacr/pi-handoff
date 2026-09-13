# Detached generation bypasses pi's model runtime — Bedrock `Validation error`

**Status:** open, needs planning (2026-09-12). Live defect: in the work
profile `/handoff` fails with `Error: Validation error: The provided model
identifier is invalid.` (twice, then `Error: Handoff failed: …`). Normal chat
on the same models works, which is what isolates the fault to this path.

### Symptom chain (verified)

- The message is **AWS Bedrock's own `ValidationException`**, not a pi-handoff
  error. pi-ai maps it verbatim — `BEDROCK_ERROR_PREFIXES = { …,
  ValidationException: "Validation error" }` in
  `pi-ai/dist/api/bedrock-converse-stream.js`. The literal phrase "model
  identifier is invalid" appears nowhere in pi's dist: it comes off the wire.
- So the request **reached Bedrock, authenticated, and was rejected on the
  modelId** — it is not auth, network, or gateway. pi sends the id unmodified
  (`commandInput = { modelId: model.id, … }`): the id was never wrong.
- Two identical errors = the two-attempt loop in
  `application/prompt-generator.ts` (`modelsToTry = [handoffModel, ctx.model]`).
  Both are `us.*` US cross-region inference profiles, so both fail identically.

### Root cause

`infrastructure/llm-client.ts` declares its own narrowed auth type and silently
drops two of the five fields `ModelRegistry.getApiKeyAndHeaders()` returns:

```ts
// infrastructure/llm-client.ts
export interface LlmAuth {
 ok: boolean;
 apiKey?: string;
 headers?: Record<string, string>;
}
```

```js
// pi-coding-agent/dist/core/model-registry.js
return {
    ok: true,
    apiKey: resolution.auth.apiKey,
    headers: resolution.auth.headers,
    ...(resolution.auth.baseUrl ? { baseUrl: resolution.auth.baseUrl } : {}),
    env: resolution.env,          // ← dropped by the extension
};
```

`env` is the field that carries regional configuration — `ProviderRequestOptions.env`
in `pi-ai/dist/types.d.ts`: *"Provider-scoped environment values. These take
precedence over `process.env` for provider configuration such as regional
settings, endpoint placeholders, and proxy variables."*

Dropping it hands region resolution back to the AWS SDK's own defaults, i.e.
`~/.config/aws/config.ini` `[default] region=ap-south-1`. The work profile pairs
`us.anthropic.claude-sonnet-5` (`defaultModel`) and
`us.anthropic.claude-haiku-4-5-20251001-v1:0` (`handoff.model`) with that
ap-south-1 default — a US cross-region inference profile invoked from an
ap-south-1 endpoint is rejected exactly this way.

Bedrock-only by construction: `env` carries no regional meaning for
devpass/zai/OpenAI-compatible providers, which is why the personal profile never
surfaced it. The README's own example uses
`global.anthropic.claude-haiku-4-5-20251001-v1:0` — region-agnostic, so it would
have masked this too.

### Fix — two shapes (decide at planning)

- **(a) Narrow:** widen `LlmAuth` to `{ ok; apiKey?; headers?; baseUrl?; env? }`
  and forward `env: auth.env` into the `streamSimple` options. Fixes today's
  failure, but keeps the hand-rolled coupling — the next provider field pi adds
  breaks it again, silently, the same way.
- **(b) Preferred — stop hand-rolling:** call the runtime instead of the
  provider. `ctx.modelRegistry.complete(model, context, { reasoning: effort,
  signal })` inherits the entire resolution chain (auth, `env`, `baseUrl`,
  headers, retries, telemetry) by construction. pi-ai's `models.d.ts` states the
  intended layering: *"Providers own stream behavior; `Models` resolves auth and
  delegates each request to the provider that owns the model."* The extension
  currently inverts exactly that — it resolves auth itself and then calls the
  raw provider function, which is *why* it owns the burden of re-forwarding
  fields by hand.

### Trade-off for (b) — streaming progress

`ModelRegistry` exposes only `complete()`; there is no `stream` on it.
`ModelRuntime` does have `streamSimple`, but `ExtensionContext` exposes only
`modelRegistry` (`core/extensions/types.d.ts`). The per-delta progress loader
(`Generating with … · thinking… 4.2k`) therefore degrades to a coarse indicator.
Partial recovery: `onResponse` (a valid `StreamOptions` field) fires once the
HTTP response lands — "generating…" transition plus elapsed time.

### Verification

`test/smoke.ts` (31 checks) is the gate. Add an assertion that the generation
call is routed through the registry, plus a case asserting the resolved auth is
passed through intact.

### Notes

- Scope `lens_diagnostics` to this repo (`paths: ["pi-handoff/"]`) — an unscoped
  call in this monorepo scans every `pi-*` repo and stalls.
- Not an upstream pi bug: dropping `env` is correct third-party behaviour only
  if you also take responsibility for re-supplying it.

