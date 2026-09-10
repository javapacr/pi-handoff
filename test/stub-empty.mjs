// Generic stub for pi runtime packages — exports the runtime symbols the
// extension chain references outside of type position.
// Container/CancellableLoader carry the minimal shape ui/handoff-loader.ts
// uses (addChild, setMessage, signal) so the executor's loader can be built
// under the harness.
export const streamSimple = async () => {
	throw new Error("stub: streamSimple not available in smoke");
};
export class CancellableLoader {
	constructor(_tui, _spinnerColor, _textColor, label) {
		this.label = label;
		this.onAbort = undefined;
		this._controller = new AbortController();
	}
	get signal() {
		return this._controller.signal;
	}
	setMessage(text) {
		this.label = text;
	}
	handleInput() {}
	dispose() {}
}
export class Container {
	constructor() {
		this.children = [];
	}
	addChild(child) {
		this.children.push(child);
	}
}
export class Spacer {
	constructor(height) {
		this.height = height;
	}
}
export class Text {
	constructor(text, x, y) {
		this.text = text;
		this.x = x;
		this.y = y;
	}
}
export class DynamicBorder {
	constructor(color) {
		this.color = color;
	}
}
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
