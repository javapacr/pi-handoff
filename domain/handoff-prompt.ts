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
 * Validate a handoff document and extract its Next Task payload.
 *
 * Returns the trimmed content following the LAST `## Next Task` heading
 * (including any `## Phase Adherence` tail — same content `splitHandoffPrompt`
 * would send as the live message), or null when the heading is missing or the
 * section is empty. Used by `handoff_launch` and `/handoff-launch` as the
 * gate before queueing the new session.
 */
export function findNextTaskSection(doc: string): string | null {
	const re = /^##\s+Next Task[^\S\n]*$/gm;
	let last: RegExpExecArray | null = null;
	let match: RegExpExecArray | null;
	while ((match = re.exec(doc)) !== null) last = match;
	if (!last) return null;
	const after = doc.slice(last.index + last[0].length);
	// The section's own content ends at the next heading (if any) — an empty
	// section with only following headings is invalid, not "content".
	const nextHeading = after.search(/^##\s/m);
	const section = (
		nextHeading === -1 ? after : after.slice(0, nextHeading)
	).trim();
	if (section.length === 0) return null;
	return after.trim();
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
