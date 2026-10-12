/**
 * Centralized event bus channel names and lifecycle event emission helpers.
 *
 * Other extensions can listen on these channels to react to handoff
 * lifecycle events (payloads and timing: README "Lifecycle events"):
 *
 * - `handoff_command_start`    — /handoff passed its has-conversation gate
 *   (trigger "handoff", carries waitUntil), or bare /continue recovered a
 *   document (trigger "continue")
 * - `handoff_command_complete` — /handoff or /continue finished (success,
 *   cancel or error); carries trigger
 * - `handoff_tool_start`       — the continue tool staged /continue, right
 *   after tui_filled_handoff
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	HandoffToolEventPayload,
	HandoffCommandStartPayload,
	HandoffCommandCompletePayload,
} from "../domain/types";

// ── Event channel names ───────────────────────────────────────────────────

export const HANDOFF_CHANNELS = {
	toolStart: "handoff_tool_start",
	commandStart: "handoff_command_start",
	commandComplete: "handoff_command_complete",
	/** Legacy channel: the continue tool pre-filled the editor. */
	tuiFilledHandoff: "tui_filled_handoff",
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

export function emitCommandStart(
	pi: ExtensionAPI,
	payload: Omit<HandoffCommandStartPayload, "timestamp">,
): void {
	pi.events.emit(HANDOFF_CHANNELS.commandStart, {
		...payload,
		timestamp: Date.now(),
	} satisfies HandoffCommandStartPayload);
}

export function emitCommandComplete(
	pi: ExtensionAPI,
	payload: Omit<HandoffCommandCompletePayload, "timestamp">,
): void {
	pi.events.emit(HANDOFF_CHANNELS.commandComplete, {
		...payload,
		timestamp: Date.now(),
	} satisfies HandoffCommandCompletePayload);
}
