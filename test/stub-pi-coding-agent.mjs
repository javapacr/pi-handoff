// Stub for @earendil-works/pi-coding-agent runtime symbols.
// Only the runtime (non-type) named imports used by the extension chain:
// convertToLlm + serializeConversation (session-adapter), DynamicBorder +
// keyHint (ui/handoff-loader).
//
// serializeConversation mirrors the real upstream rendering (per-block
// emission, [User]:/[Assistant]:/[Tool result]: markers, 2000-char tool
// result cap, an assistant message emptied of all blocks rendering nothing)
// so the skipTools slice (D9) can assert stubbing in the SERIALIZED text.
// convertToLlm stays an identity pass — the real one passes user/assistant/
// toolResult through unchanged, which is all this suite feeds it.
export const convertToLlm = (messages) => messages;

const contentText = (content, separator = "\n") => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text)
		.join(separator);
};

export const serializeConversation = (messages) => {
	const parts = [];
	for (const msg of messages ?? []) {
		if (msg?.role === "user") {
			// upstream passes "" explicitly for user/toolResult (utils.js:98,126)
			const content = contentText(msg.content, "");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg?.role === "assistant") {
			const thinkingParts = [];
			const toolCalls = [];
			for (const block of msg.content ?? []) {
				if (block?.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block?.type === "toolCall") {
					const argsStr = Object.entries(block.arguments ?? {})
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}
			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if ((msg.content ?? []).some((block) => block?.type === "text")) {
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg?.role === "toolResult") {
			const content = contentText(msg.content, "");
			if (content) {
				parts.push(
					`[Tool result]: ${
						content.length <= 2000
							? content
							: `${content.slice(0, 2000)}\n\n[... ${content.length - 2000} more characters truncated]`
					}`,
				);
			}
		}
	}
	return parts.join("\n\n");
};

// DynamicBorder is constructed by ui/handoff-loader.ts — keep it a class.
export class DynamicBorder {
	constructor(color) {
		this.color = color;
	}
}
export const keyHint = (k) => k;
export default {};
