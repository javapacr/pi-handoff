/**
 * LLM adapter for handoff prompt generation.
 *
 * Thin wrapper around `completeSimple` that turns a provider response into a
 * plain string. Returns `null` when the call is aborted.
 */

import {
	completeSimple,
	type Message,
	type Model,
	type Api,
	type ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface LlmAuth {
	ok: boolean;
	apiKey?: string;
	headers?: Record<string, string>;
}

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
): Promise<string | null> {
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(
			`Authentication failed for handoff model "${model.id}". ` +
				`Check that the model is enabled and API credentials are configured.`,
		);
	}

	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: request.userPayload }],
		timestamp: Date.now(),
	};

	const response = await completeSimple(
		model,
		{ systemPrompt: request.systemPrompt, messages: [userMessage] },
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal,
			reasoning: effort,
		},
	);

	if (response.stopReason === "aborted") return null;

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}
