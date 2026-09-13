/**
 * LLM adapter for handoff prompt generation.
 *
 * Routes generation through the pi model runtime (`ModelRegistry.complete`)
 * instead of hand-resolving auth and calling the raw provider: `complete`
 * inherits the entire resolution chain (apiKey, headers, baseUrl, and the
 * provider-scoped `env` that carries Bedrock regional config) by construction.
 * Hand-assembling a narrowed auth subset is what silently dropped `env` and
 * broke US cross-region inference profiles invoked from a non-US region.
 *
 * `complete()` resolves to the final message only, so streaming progress
 * degrades to a coarse indicator: `onResponse` fires once the HTTP response
 * lands. Returns `null` when the call is aborted.
 *
 * The detached handoff call is one-shot — nothing ever re-reads the generated
 * prefix — so the request opts out of prompt caching (`cacheRetention:
 * "none"`); the default "short" would bill a 1.25× cache-write premium with
 * no reader. Detached path only; never apply this to warm-path calls.
 */

import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface LlmRequest {
	systemPrompt: string;
	userPayload: string;
}

export async function generateWithModel(
	model: Model<Api>,
	registry: ModelRegistry,
	request: LlmRequest,
	signal: AbortSignal | undefined,
	effort: ThinkingLevel | undefined,
	onResponse?: () => void,
): Promise<string | null> {
	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: request.userPayload }],
		timestamp: Date.now(),
	};

	const context: Context = {
		systemPrompt: request.systemPrompt,
		messages: [userMessage],
	};

	const result: AssistantMessage = await registry.complete(model, context, {
		// Raw provider streams read different fields: bedrock maps `reasoning`;
		// openai-compatible (zai/deepseek/openai) reads `reasoningEffort` only.
		// Pass both so effort survives the registry facade (streamSimple's
		// ThinkingLevel mapping is not applied on this path). anthropic-direct
		// remains unmapped — documented limitation.
		reasoning: effort,
		reasoningEffort: effort,
		signal,
		cacheRetention: "none",
		onResponse: () => onResponse?.(),
	});

	if (result.stopReason === "aborted") return null;
	if (result.stopReason === "error") {
		throw new Error(
			result.errorMessage ?? `Model ${model.id} failed without an error message`,
		);
	}

	return result.content
		.filter(
			(c: { type: string }): c is { type: "text"; text: string } =>
				c.type === "text",
		)
		.map((c: { type: "text"; text: string }) => c.text)
		.join("\n");
}
