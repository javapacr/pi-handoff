/**
 * Event registration for the handoff extension.
 *
 * Registers lifecycle hooks:
 * - session_start notification when a new session was created from a handoff.
 * - tui_filled_handoff → agent_end auto-submit: when the request_handoff tool
 *   pre-fills the editor with `/handoff <goal>` and the process is inside a
 *   supported terminal multiplexer, automatically sends Enter to the pane
 *   after the agent turn ends.
 * - tui_handoff_completed → auto-submit: when /handoff finishes generating
 *   the prompt and shows the editor review overlay, automatically sends Enter
 *   to confirm the review.
 *
 * Supports both tmux and herdr backends via the terminal strategy.
 */

import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
	HandoffOriginData,
	TuiHandoffCompletedPayload,
} from "../domain/types";
import { loadHandoffSettings } from "./config-repository";
import {
	captureTerminalContext,
	resolveTerminalMode,
	sendEnter,
	type TerminalContext,
} from "./terminal-strategy";

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
 * Terminal context captured at tui_filled_handoff emit time. When non-null,
 * an auto-submit is pending and will fire on the next agent_end.
 */
let pendingAutoSubmit: TerminalContext | null = null;

/** Safety timeout handle for the pending flag. */
let pendingFlagTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingAutoSubmit(): void {
	pendingAutoSubmit = null;
	if (pendingFlagTimer) {
		clearTimeout(pendingFlagTimer);
		pendingFlagTimer = null;
	}
}

export function registerHandoffEvents(pi: ExtensionAPI): void {
	// ── session_start: notify when a session was created from a handoff ──────

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "new") return;

		const entries = ctx.sessionManager.getEntries();
		const originEntry = entries.find(
			(e): e is Extract<SessionEntry, { type: "custom" }> =>
				e.type === "custom" &&
				(e as unknown as { customType?: string }).customType ===
					"handoff-origin",
		);

		if (!originEntry) return;

		const data = (originEntry as unknown as { data?: HandoffOriginData }).data;
		const goalHint = data?.goal ? `: ${data.goal.slice(0, 50)}` : "";
		ctx.ui.notify(`↩ Continued from previous session${goalHint}`, "info");
	});

	// ── tui_filled_handoff: capture terminal context for auto-submit ────────

	pi.events.on("tui_filled_handoff", async () => {
		const settings = loadHandoffSettings();
		const ctx = await captureTerminalContext(settings?.terminal);
		if (!ctx) return;

		pendingAutoSubmit = ctx;

		// Safety: clear the flag after a timeout in case agent_end never fires.
		if (pendingFlagTimer) clearTimeout(pendingFlagTimer);
		pendingFlagTimer = setTimeout(
			() => clearPendingAutoSubmit(),
			PENDING_FLAG_TIMEOUT_MS,
		);
	});

	// ── agent_end: auto-submit Enter if a handoff is pending ────────────────

	pi.on("agent_end", () => {
		if (pendingAutoSubmit === null) return;

		const ctx = pendingAutoSubmit;
		clearPendingAutoSubmit();

		// Small delay for the TUI to settle after the agent turn ends.
		setTimeout(() => {
			sendEnter(ctx);
		}, AUTO_SUBMIT_DELAY_MS);
	});

	// ── tui_handoff_completed: auto-submit Enter for editor review ───────────
	//
	// Fires when /handoff has generated the prompt and is about to show the
	// editor review overlay. The listener captures the terminal context and
	// sends Enter after a delay long enough for the overlay to render.

	pi.events.on("tui_handoff_completed", async (data: unknown) => {
		const settings = loadHandoffSettings();
		const payload = data as TuiHandoffCompletedPayload;

		// Use the terminal context captured at the start of executeHandoff()
		// (before LLM generation). If the user switched terminal tabs during
		// generation, this is still the original pi pane.
		let ctx: TerminalContext | null = null;

		if (payload?.paneId) {
			const mode = resolveTerminalMode(settings?.terminal);
			if (mode) {
				ctx = { mode, paneId: payload.paneId };
			}
		}

		// Fall back to live capture for safety.
		if (!ctx) {
			ctx = await captureTerminalContext(settings?.terminal);
		}

		if (!ctx) return;

		const captured = ctx;

		// 500ms gives the editor overlay time to render before Enter is sent.
		setTimeout(() => {
			sendEnter(captured);
		}, 500);
	});
}
