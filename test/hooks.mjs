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

// node:child_process is stubbed only for the STAGED tree (parentURL under
// the pih-stage- dir): pbcopy is recorded, not executed (W2 rescue paths
// must not touch the real clipboard); smoke.ts itself and the live-git
// block keep the real builtin.
const CHILD_PROCESS_STUB = new URL("./stub-child-process.mjs", import.meta.url)
	.href;

// Generation is exercised for real: infrastructure/llm-client.ts routes
// through `ModelRegistry.complete`, and the smoke's mock ctx supplies a
// capturing registry (see makeRegistryCapture in smoke.ts).

export async function resolve(specifier, context, next) {
	for (const [pkg, stub] of Object.entries(STUBS)) {
		if (specifier === pkg || specifier.startsWith(pkg + "/")) {
			return { url: stub, shortCircuit: true };
		}
	}
	if (
		specifier === "node:child_process" &&
		String(context.parentURL ?? "").includes("pih-stage-")
	) {
		return { url: CHILD_PROCESS_STUB, shortCircuit: true };
	}
	return next(specifier, context);
}
