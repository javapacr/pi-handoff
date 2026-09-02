/**
 * LLM adapter for handoff prompt generation.
 *
 * Thin wrapper around `streamSimple` that turns a provider response into a
 * plain string while reporting thinking/writing progress as the stream
 * arrives. Returns `null` when the call is aborted.
 */

import {
	streamSimple,
	type Message,
	type Model,
	type Api,
	type ThinkingLevel,
} from "@earendil-works/pi-ai/compat";
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

export interface LlmProgress {
	phase: "thinking" | "writing";
	chars: number;
}

export async function generateWithModel(
	model: Model<Api>,
	registry: ModelRegistry,
	request: LlmRequest,
	signal: AbortSignal | undefined,
	effort: ThinkingLevel | undefined,
	onProgress?: (p: LlmProgress) => void,
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

	const stream = streamSimple(
		model,
		{ systemPrompt: request.systemPrompt, messages: [userMessage] },
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal,
			reasoning: effort,
		},
	);

	let text = "";
	let thinkingChars = 0;

	for await (const event of stream) {
		if (event.type === "thinking_delta") {
			thinkingChars += event.delta.length;
			onProgress?.({ phase: "thinking", chars: thinkingChars });
		} else if (event.type === "text_delta") {
			text += event.delta;
			onProgress?.({ phase: "writing", chars: text.length });
		} else if (event.type === "error") {
			if (event.reason === "aborted") return null;
			throw new Error(
				event.error.errorMessage ??
					`Model ${model.id} stream failed without an error message`,
			);
		}
	}

	const result = await stream.result();
	if (result.stopReason === "aborted") return null;

	return result.content
		.filter(
			(c: { type: string }): c is { type: "text"; text: string } =>
				c.type === "text",
		)
		.map((c: { type: "text"; text: string }) => c.text)
		.join("\n");
}
