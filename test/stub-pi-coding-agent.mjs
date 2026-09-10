// Stub for @earendil-works/pi-coding-agent runtime symbols.
// Only the runtime (non-type) named imports used by the extension chain:
// convertToLlm + serializeConversation (session-adapter), DynamicBorder +
// keyHint (ui/handoff-loader).
export const convertToLlm = (messages) => messages;
export const serializeConversation = (messages) =>
	messages
		.map((m) => {
			if (m?.role === "user") return `[User] ${typeof m.content === "string" ? m.content : ""}`;
			if (m?.role === "assistant") return "[Assistant]";
			return "";
		})
		.join("\n");
// DynamicBorder is constructed by ui/handoff-loader.ts — keep it a class.
export class DynamicBorder {
	constructor(color) {
		this.color = color;
	}
}
export const keyHint = (k) => k;
export default {};
