// Stub for infrastructure/llm-client.ts — the smoke harness has no real model
// stream (the pi-ai stub's streamSimple throws). The executor smoke supplies
// the generated document through the PIH_SMOKE_HANDOFF_DOC env var; the
// executor, the prompt generator, and the loader UI all run for real around it.
export async function generateWithModel() {
	const doc = process.env.PIH_SMOKE_HANDOFF_DOC;
	if (!doc)
		throw new Error(
			"stub: PIH_SMOKE_HANDOFF_DOC is not set — the smoke harness must supply the generated handoff document",
		);
	return doc;
}

export default { generateWithModel };
