// Generic stub for pi runtime packages — exports the runtime symbols the
// extension chain references outside of type position.
export const streamSimple = async () => {
	throw new Error("stub: streamSimple not available in smoke");
};
export class CancellableLoader {}
export class Container {}
export class Spacer {}
export class Text {}
export const DynamicBorder = "─";
export const keyHint = (k) => k;
export const convertToLlm = (messages) => messages;
export const serializeConversation = (messages) =>
	messages
		.map((m) =>
			m?.role === "user"
				? `[User] ${typeof m.content === "string" ? m.content : ""}`
				: m?.role === "assistant"
					? "[Assistant]"
					: "",
		)
		.join("\n");
export default {};
