/**
 * Pure domain helpers for handoff prompts.
 */

/**
 * Content of the LAST `## Next Task` section — everything between its heading
 * and the next heading (or EOF), trimmed. Null when the heading is missing or
 * the section is empty. Deliberately EXCLUDES any trailing sections (e.g. a
 * legacy `## Phase Adherence`).
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
 * Content of the LAST `## Phase Adherence` heading → end of text, WHEN that
 * heading is the document's final section; returned trimmed of the trailing
 * blank line the section boundary leaves behind. Passthrough (byte-identical)
 * when no trailing PA section exists — a PA followed by a later section is
 * never touched. The LAST heading wins when several are present.
 *
 * This is the `continue` tool's normalize step and the `/continue` recovery's
 * idempotent strip (D10/D11): a legacy trailing `## Phase Adherence` is
 * stripped so it never rides along in the document body.
 */
export function stripTrailingPhaseAdherence(doc: string): string {
	const re = /^##\s+Phase Adherence[^\S\n]*$/gm;
	let last: RegExpExecArray | null = null;
	let match: RegExpExecArray | null;
	while ((match = re.exec(doc)) !== null) last = match;
	if (!last) return doc;
	const after = doc.slice(last.index + last[0].length);
	if (after.search(/^##\s/m) !== -1) return doc;
	return doc.slice(0, last.index).trimEnd();
}

/**
 * Build the live first message for the new session: the provenance line, an
 * optional machine-written session-state line, and the FULL handoff document
 * (legacy-PA-stripped by the caller — see `stripTrailingPhaseAdherence`) — as
 * ONE visible message. The document IS the message; there is no path and no
 * read-first instruction (no-doc rehaul, D11). Returns null when the document
 * is invalid (missing/empty Next Task) — the caller turns that into the
 * repair-loop result / error notify.
 */
export function buildContinuationPrompt(
	provenanceLine: string,
	doc: string,
	stateLine: string | null = null,
): string | null {
	const task = findNextTaskContent(doc);
	if (task === null) return null;
	const header = stateLine === null ? provenanceLine : `${provenanceLine}\n${stateLine}`;
	return `${header}\n\n${doc}`;
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
