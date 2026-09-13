/**
 * Machine-stamped provenance header for handoff documents (design D3 + D8).
 *
 * Byte line 1 of a saved handoff doc:
 *
 *   <!-- pi-handoff v<N> | session: <absolute session-JSONL path> | saved: <ISO-8601> -->
 *
 * Non-load-bearing: no parser reads it — humans and the next session's agent
 * (who read the doc first) see the linkage; the machine record is the hidden
 * `handoff-origin` entry. The version token renders from
 * HANDOFF_TEMPLATE_VERSION and is the ONLY version stamp (the origin entry
 * carries no templateVersion field). Stamped at the creation surfaces only
 * (detached save + the `continue` tool); `/continue` never writes.
 */

import { HANDOFF_TEMPLATE_VERSION } from "./handoff-template";

/** First token of the header — the idempotence check key. */
export const PROVENANCE_HEADER_PREFIX = "<!-- pi-handoff v";

/**
 * Build the header line INCLUDING its single trailing newline (the separator
 * before the doc body). Null-safe on the session file: when unavailable, the
 * session segment is omitted rather than rendered as "null".
 */
export function buildProvenanceHeader(
	sessionFile: string | undefined,
	savedAt: Date = new Date(),
): string {
	const sessionSegment = sessionFile ? ` | session: ${sessionFile}` : "";
	return `<!-- pi-handoff v${HANDOFF_TEMPLATE_VERSION}${sessionSegment} | saved: ${savedAt.toISOString()} -->\n`;
}

/** True when the doc already carries the provenance header (line 1). */
export function isProvenanceStamped(doc: string): boolean {
	return doc.startsWith(PROVENANCE_HEADER_PREFIX);
}

/**
 * Prepend the provenance header unless the doc is already stamped
 * (idempotent — user-edited docs keep whatever header they carry).
 */
export function stampIfAbsent(
	doc: string,
	sessionFile: string | undefined,
): string {
	return isProvenanceStamped(doc)
		? doc
		: buildProvenanceHeader(sessionFile) + doc;
}
