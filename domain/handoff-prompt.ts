/**
 * Pure domain helpers for handoff prompts.
 */

/**
 * Split a generated handoff prompt at the last ## Next Task header.
 * The context block is pre-seeded into the session via setup().
 * The next-task text is sent as the live user message that triggers the agent.
 */
export function splitHandoffPrompt(prompt: string): {
	context: string;
	nextTask: string;
} {
	const marker = "\n## Next Task";
	const idx = prompt.lastIndexOf(marker);
	if (idx === -1) return { context: "", nextTask: prompt };
	return {
		context: prompt.slice(0, idx).trim(),
		nextTask: prompt.slice(idx + marker.length).trim(),
	};
}

/**
 * Derive a short session title from the goal arg or first line of next-task text.
 */
export function deriveSessionTitle(
	goal: string | null,
	nextTask: string,
): string {
	const raw = goal || nextTask.split("\n")[0].trim() || "Handoff session";
	return raw.length > 70 ? raw.slice(0, 67) + "…" : raw;
}
