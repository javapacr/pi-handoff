/**
 * Centralized event bus channel names and lifecycle event emission helpers.
 *
 * Other extensions can listen on these channels to react to handoff
 * lifecycle events:
 *
 * - `handoff_tool_start`    — request_handoff tool was called
 * - `handoff_tool_end`      — request_handoff tool finished
 * - `handoff_command_start` — /handoff command began
 * - `handoff_command_complete` — /handoff command finished (success or failure)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	HandoffToolEventPayload,
	HandoffCommandEventPayload,
} from "../domain/types";

// ── Event channel names ───────────────────────────────────────────────────

export const HANDOFF_CHANNELS = {
	toolStart: "handoff_tool_start",
	toolEnd: "handoff_tool_end",
	commandStart: "handoff_command_start",
	commandComplete: "handoff_command_complete",
	/** Legacy channel: request_handoff pre-filled the editor. */
	tuiFilledHandoff: "tui_filled_handoff",
	/** Legacy channel: /handoff generated prompt, about to show editor. */
	tuiHandoffCompleted: "tui_handoff_completed",
} as const;

// ── Emission helpers ──────────────────────────────────────────────────────

export function emitToolStart(
	pi: ExtensionAPI,
	payload: Omit<HandoffToolEventPayload, "timestamp">,
): void {
	pi.events.emit(HANDOFF_CHANNELS.toolStart, {
		...payload,
		timestamp: Date.now(),
	} satisfies HandoffToolEventPayload);
}

export function emitToolEnd(
	pi: ExtensionAPI,
	payload: Omit<HandoffToolEventPayload, "timestamp">,
): void {
	pi.events.emit(HANDOFF_CHANNELS.toolEnd, {
		...payload,
		timestamp: Date.now(),
	} satisfies HandoffToolEventPayload);
}

export function emitCommandStart(
	pi: ExtensionAPI,
	payload: Omit<HandoffCommandEventPayload, "timestamp">,
): void {
	pi.events.emit(HANDOFF_CHANNELS.commandStart, {
		...payload,
		timestamp: Date.now(),
	} satisfies HandoffCommandEventPayload);
}

export function emitCommandComplete(
	pi: ExtensionAPI,
	payload: Omit<HandoffCommandEventPayload, "timestamp">,
): void {
	pi.events.emit(HANDOFF_CHANNELS.commandComplete, {
		...payload,
		timestamp: Date.now(),
	} satisfies HandoffCommandEventPayload);
}
