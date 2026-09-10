/**
 * Pure domain helpers for handoff prompts.
 */

import { HANDOFF_PHASE_ADHERENCE } from "./handoff-template";

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
 * Content of the LAST `## Next Task` section — everything between its heading
 * and the next heading (or EOF), trimmed. Null when the heading is missing or
 * the section is empty. Deliberately EXCLUDES any model-authored trailing
 * sections (e.g. a `## Phase Adherence` variant) — the canonical text is
 * appended by `buildContinuationPrompt` instead.
 */
export function findNextTaskContent(doc: string): string | null {
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
	return section.length > 0 ? section : null;
}

/**
 * Build the live first message for the new session: the handoff document
 * path (with a read-first instruction), the Next Task content, and the
 * CANONICAL Phase Adherence section owned by the extension — as ONE visible
 * message. The document body is NOT embedded; the new session reads it from
 * disk on demand. Returns null when the document is invalid (missing/empty
 * Next Task) — the caller turns that into the repair-loop result.
 */
export function buildContinuationPrompt(
	doc: string,
	docPath: string,
): string | null {
	const task = findNextTaskContent(doc);
	if (task === null) return null;
	return (
		`Handoff document: ${docPath}\n` +
		`Read it with the read tool before acting.\n\n` +
		`${task}\n\n` +
		`${HANDOFF_PHASE_ADHERENCE}`
	);
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
