/**
 * handoff.skipTools — pre-serialization stub filter (design 2026-09-13, D9).
 *
 * Some tool traffic is pure noise in a handoff document: agent-composed
 * re-encodings of session content (MemPalace diary writes) and external
 * state mutations (jira writes). This module drops matched tool-call blocks
 * and stubs matched tool results out of the SERIALIZED conversation only.
 *
 * Settings: self-loaded via loadHandoffSettings() on every use (fresh read —
 * the per-use reload pattern in event-registration.ts), keeping
 * buildConversationText's signature unchanged. A valid `handoff.skipTools`
 * array REPLACES the defaults; `[]` disables filtering entirely; a malformed
 * value (non-array, or any non-string entry) is ignored entirely with a
 * one-line warning notify (non-blocking, defaults stay active).
 *
 * HARD RULE — clone before mutate: getHandoffMessages() returns the live
 * session branch's message objects BY REFERENCE. Mutating them in place
 * would corrupt the session for compaction and any second /handoff, so the
 * filter deep-clones before touching anything and only ever edits the clone.
 * Tool-result `details` is NEVER touched (extractTodos reads it — even a
 * user pattern matching `todo` cannot break todo extraction).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { loadHandoffSettings } from "./config-repository";

/**
 * Default skip patterns. Copy-extend via `handoff.skipTools` in settings.json
 * (a configured list REPLACES this one — it does not merge).
 *
 * Reads are deliberately NOT defaulted (mempalace recall/search, diary_read,
 * jira reads): their results inject external state that exists nowhere else
 * in the session. The documented admission rule is to keep any call whose
 * result would be lost.
 */
export const DEFAULT_SKIP_TOOLS = [
	// MemPalace diary writes re-encode session content as diary entries —
	// noise in a handoff. The leading * covers both the plain name and the
	// server-prefixed form (mempalace-personal_mempalace_diary_write).
	"*mempalace_diary_write",
	// MemPalace reconnection churn (same prefix variance).
	"*mempalace_reconnect",
	// pi-atlassian's only write tools (its other tools are reads); direct
	// extension tools, no prefix variance.
	"jira_assign_ticket",
	"jira_update_status",
	// The `continue` tool call carries the full handoff document in its
	// arguments — the same document that rides the session as the next
	// handoff's live first message. Skipping collapses that duplicate copy in
	// future serializations (no-doc rehaul D11, duplication accounting).
	"continue",
] as const;

/** Non-blocking notify sink (mirrors ctx.ui.notify; optional). */
export type SkipNotify = (
	message: string,
	level?: "info" | "warning" | "error",
) => void;

/**
 * Glob matcher: `*` is the only metacharacter and matches zero or more
 * characters; everything else is a case-sensitive literal, anchored to the
 * full tool name. So `*mempalace_diary_write` matches both
 * `mempalace_diary_write` and `mempalace-personal_mempalace_diary_write`
 * while `mempalace-personal_mempalace_search` stays unmatched.
 */
function matchesSkipPattern(toolName: string, pattern: string): boolean {
	if (typeof toolName !== "string") return false;
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("[\\s\\S]*");
	return new RegExp(`^${source}$`).test(toolName);
}

/**
 * Resolve the active patterns for this use. Fresh settings read on every
 * call; a malformed value falls back to the defaults with a one-line
 * warning notify.
 */
function resolveSkipPatterns(notify: SkipNotify | undefined): string[] {
	const configured = loadHandoffSettings()?.skipTools;
	if (configured === undefined) return [...DEFAULT_SKIP_TOOLS];
	if (
		!Array.isArray(configured) ||
		configured.some((entry) => typeof entry !== "string")
	) {
		notify?.(
			"handoff.skipTools must be an array of strings — setting ignored, defaults active",
			"warning",
		);
		return [...DEFAULT_SKIP_TOOLS];
	}
	return configured;
}

/**
 * Return a filtered DEEP CLONE of `messages` with skip-listed tool traffic
 * stubbed: matching assistant `toolCall` blocks are dropped (their arguments
 * are the noise) and matching tool results get their `content` replaced with
 * exactly one line — `[skipped by handoff.skipTools: <toolName>]`. Call-side
 * (block.name) and result-side (toolName) matching are independent. The
 * input (live branch objects) is never mutated; `details` fields are
 * preserved untouched. An empty configured list (`[]`) disables filtering
 * entirely.
 */
export function applySkipToolFilter(
	messages: AgentMessage[],
	notify?: SkipNotify,
): AgentMessage[] {
	const patterns = resolveSkipPatterns(notify);
	if (patterns.length === 0) return messages;

	const isSkipped = (toolName: string) =>
		patterns.some((pattern) => matchesSkipPattern(toolName, pattern));

	// Clone before mutate — the input holds live branch objects by reference.
	const cloned = structuredClone(messages);

	for (const msg of cloned) {
		if (msg.role === "assistant") {
			if (!Array.isArray(msg.content)) continue;
			msg.content = msg.content.filter(
				(block) =>
					!(
						typeof block === "object" &&
						block !== null &&
						block.type === "toolCall" &&
						isSkipped(block.name)
					),
			);
		} else if (msg.role === "toolResult") {
			if (typeof msg.toolName !== "string" || !isSkipped(msg.toolName)) continue;
			// Content ONLY — never `details` (extractTodos reads it).
			msg.content = [
				{
					type: "text",
					text: `[skipped by handoff.skipTools: ${msg.toolName}]`,
				},
			];
		}
	}
	return cloned;
}
