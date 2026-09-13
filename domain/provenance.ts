/**
 * Machine-stamped provenance line for handoffs (design D3 + D8/D10).
 *
 * Byte line 1 of a saved handoff doc, and first line of a new session's live
 * handoff message:
 *
 *   <!-- pi-handoff v<N> | session: <absolute session-JSONL path> | saved: <ISO-8601> -->
 *
 * Non-load-bearing: no parser reads it — humans and the next session's agent
 * see the linkage; the machine record is the hidden `handoff-origin` entry.
 * The version token renders from HANDOFF_TEMPLATE_VERSION and is the ONLY
 * version stamp (the origin entry carries no templateVersion field).
 *
 * The warm path NEVER writes: the `continue` tool computes the line in
 * memory for its staging record, and `/continue` recomputes it at launch,
 * prepending it to the live first message. The cold path (`/handoff`,
 * no-doc rehaul D12) composes the same line in memory at launch — no
 * artifact is written anywhere.
 */

import { HANDOFF_TEMPLATE_VERSION } from "./handoff-template";

/** First token of the header — the idempotence check key. */
export const PROVENANCE_HEADER_PREFIX = "<!-- pi-handoff v";

/**
 * Build the bare provenance comment line (NO trailing newline) — the form
 * shared by the on-disk header and the live message's first line. Null-safe
 * on the session file: when unavailable, the session segment is omitted
 * rather than rendered as "null".
 */
export function buildProvenanceLine(
	sessionFile: string | undefined,
	savedAt: Date = new Date(),
): string {
	const sessionSegment = sessionFile ? ` | session: ${sessionFile}` : "";
	return `<!-- pi-handoff v${HANDOFF_TEMPLATE_VERSION}${sessionSegment} | saved: ${savedAt.toISOString()} -->`;
}
