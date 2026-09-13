# `handoff.effort` unmapped on anthropic-direct after the registry migration

**Status:** open — documented limitation (2026-09-13, discovered in review of
commit `96acd50`); revisit only if a direct-Anthropic model enters a profile's
`handoff` config.

Commit `96acd50` routed detached `/handoff` generation through
`ctx.modelRegistry.complete` (approved fix for
[bedrock-validation-error.md](bedrock-validation-error.md)). The registry
facade calls the **raw** provider stream; the `ThinkingLevel` → per-provider
mapping lives only in `streamSimple`'s wrapper. Raw-stream field shapes
(verified, pi-ai 0.84.1):

- **bedrock** reads `reasoning` — works (the fix's target).
- **openai-compatible** (zai/deepseek/devpass/openai) reads `reasoningEffort`
  — covered since `96acd50` passes it alongside `reasoning`.
- **anthropic-direct** reads `thinkingEnabled` / `thinkingBudgetTokens` /
  adaptive-model `effort` (anthropic-messages.d.ts) — **unmapped**.

Not a one-field fix: `streamSimple`'s wrapper (anthropic-messages.js:616–636)
also runs `adjustMaxTokensForThinking` — maxTokens must shrink to leave room
for thinking on budget-based models. Duplicating that mapping in pi-handoff
re-imports the hand-rolled per-provider coupling the registry migration
removed (the root-cause pattern named in bedrock-validation-error.md), and
naively passing `thinkingEnabled: true` can break budget-model requests.

**Zero current impact:** no profile configures a direct-Anthropic handoff
model (personal: zai/deepseek; work: amazon-bedrock). The smoke suite stubs
the registry, so a "provider-shape test" there would assert the stub, not
pi-ai behavior — not worth adding for an unused provider.

**Fix shape when needed:** the clean route is upstream — a
`completeSimple`-style ThinkingLevel-aware method on `ModelRegistry` (the
facade currently exposes only `complete`). Fallback: local mapping layer
(adaptive models: `thinkingEnabled + effort`; budget models: budget +
maxTokens adjustment) — accepted only with a real anthropic-direct model to
test against.
