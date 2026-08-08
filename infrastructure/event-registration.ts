/**
 * Event registration for the handoff extension.
 *
 * Registers lifecycle hooks:
 * - session_start notification when a new session was created from a handoff.
 * - tui_filled_handoff → agent_end auto-submit: when the request_handoff tool
 *   pre-fills the editor with `/handoff <goal>` and the process is inside tmux,
 *   automatically sends Enter to the pane after the agent turn ends.
 * - tui_handoff_completed → auto-submit: when /handoff finishes generating
 *   the prompt and shows the editor review overlay, automatically sends Enter
 *   to confirm the review via tmux.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	HandoffOriginData,
	TuiHandoffCompletedPayload,
} from "../domain/types";
import {
	getCurrentTmuxPaneId,
	isTmuxSession,
	sendEnterToPane,
} from "./tmux-client";

/**
 * Delay (ms) after agent_end before sending Enter. Gives the TUI time to
 * settle and render the pre-filled editor text.
 */
const AUTO_SUBMIT_DELAY_MS = 200;

/**
 * Safety timeout (ms) to auto-clear the pending flag if agent_end never fires
 * (e.g. agent crashed, user interrupted). Prevents a stale flag from triggering
 * on an unrelated future agent_end.
 */
const PENDING_FLAG_TIMEOUT_MS = 30_000;

/**
 * Pane id captured at tui_filled_handoff emit time. When non-null, an
 * auto-submit is pending and will fire on the next agent_end.
 */
let pendingAutoSubmitPane: string | null = null;

/** Safety timeout handle for the pending flag. */
let pendingFlagTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingAutoSubmit(): void {
	pendingAutoSubmitPane = null;
	if (pendingFlagTimer) {
		clearTimeout(pendingFlagTimer);
		pendingFlagTimer = null;
	}
}

export function registerHandoffEvents(pi: ExtensionAPI): void {
	// ── session_start: notify when a session was created from a handoff ──────

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "new") return;

		const entries = ctx.sessionManager.getEntries();
		const originEntry = entries.find(
			(e) => e.type === "custom" && (e as any).customType === "handoff-origin",
		) as any | undefined;

		if (!originEntry) return;

		const data = originEntry.data as HandoffOriginData | undefined;
		const goalHint = data?.goal ? `: ${data.goal.slice(0, 50)}` : "";
		ctx.ui.notify(`↩ Continued from previous session${goalHint}`, "info");
	});

	// ── tui_filled_handoff: capture pane for auto-submit ────────────────────

	pi.events.on("tui_filled_handoff", (_data) => {
		// Only auto-submit when inside tmux.
		if (!isTmuxSession()) return;

		const paneId = getCurrentTmuxPaneId();
		if (!paneId) return;

		pendingAutoSubmitPane = paneId;

		// Safety: clear the flag after a timeout in case agent_end never fires.
		if (pendingFlagTimer) clearTimeout(pendingFlagTimer);
		pendingFlagTimer = setTimeout(
			() => clearPendingAutoSubmit(),
			PENDING_FLAG_TIMEOUT_MS,
		);
	});

	// ── agent_end: auto-submit Enter if a handoff is pending ────────────────

	pi.on("agent_end", async () => {
		if (pendingAutoSubmitPane === null) return;

		const paneId = pendingAutoSubmitPane;
		clearPendingAutoSubmit();

		// Small delay for the TUI to settle after the agent turn ends.
		setTimeout(() => {
			sendEnterToPane(paneId);
		}, AUTO_SUBMIT_DELAY_MS);
	});

	// ── tui_handoff_completed: auto-submit Enter for editor review ───────────
	//
	// Fires when /handoff has generated the prompt and is about to show the
	// editor review overlay. The listener captures the pane and sends Enter
	// after a delay long enough for the overlay to render.

	pi.events.on("tui_handoff_completed", (data: unknown) => {
		if (!isTmuxSession()) return;

		// Use the pane id captured at the start of executeHandoff() (before LLM
		// generation). If the user switched tmux tabs during generation, this is
		// still the original pi pane. Fall back to live capture for safety.
		const payload = data as TuiHandoffCompletedPayload;
		const paneId = payload?.tmuxPaneId ?? getCurrentTmuxPaneId();
		if (!paneId) return;

		// 500ms gives the editor overlay time to render before Enter is sent.
		setTimeout(() => {
			sendEnterToPane(paneId);
		}, 500);
	});
}
