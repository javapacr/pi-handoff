// Module hooks: stub pi's packages for out-of-process smoke testing.
// The real packages drift from pi's runtime aliases (pi aliases bare imports
// for extensions at load time); the smoke only needs the extension's own code
// to execute, with these runtime symbols present.
import { pathToFileURL } from "node:url";

const STUBS = {
	"@earendil-works/pi-coding-agent": new URL(
		"./stub-pi-coding-agent.mjs",
		import.meta.url,
	).href,
	"@earendil-works/pi-ai": new URL("./stub-empty.mjs", import.meta.url).href,
	"@earendil-works/pi-agent-core": new URL("./stub-empty.mjs", import.meta.url)
		.href,
	"@earendil-works/pi-tui": new URL("./stub-empty.mjs", import.meta.url).href,
	typebox: new URL("./stub-empty.mjs", import.meta.url).href,
};

// Relative imports inside the staged tree that cannot run in-process:
// infrastructure/llm-client.ts opens a real model stream. The executor smoke
// supplies the generated document through stub-llm-client.mjs instead.
const LLM_CLIENT_STUB = new URL("./stub-llm-client.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
	if (/\/infrastructure\/llm-client(\.ts)?$/.test(specifier)) {
		return { url: LLM_CLIENT_STUB, shortCircuit: true };
	}
	for (const [pkg, stub] of Object.entries(STUBS)) {
		if (specifier === pkg || specifier.startsWith(pkg + "/")) {
			return { url: stub, shortCircuit: true };
		}
	}
	return next(specifier, context);
}
