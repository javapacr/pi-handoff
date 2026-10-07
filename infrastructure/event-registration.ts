/**
 * Event registration for the handoff extension.
 *
 * Registers lifecycle hooks:
 * - session_start notification when a new session was created from a handoff.
 * - tui_filled_handoff → agent_settled auto-submit: when the `continue` tool
 *   stages bare `/continue` in the editor and the process is inside a
 *   supported terminal multiplexer, automatically sends Enter to the pane
 *   once the agent run has settled. This is the warm path's launch beat
 *   (no-doc rehaul, D10) and the surviving captureTerminalContext call site
 *   that keeps the herdr context file alive.
 *
 * Why agent_settled, not agent_end (pi 1.0 extensions.md "Respect the runtime
 * lifecycle"): agent_end can be followed by automatic retries, compaction, or
 * queued work; agent_settled fires only once pi will not continue
 * automatically, so the Enter never lands mid-retry or mid-compaction.
 *
 * Supports both tmux and herdr backends via the terminal strategy.
 */

import { basename } from "node:path";
import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { HandoffOriginData } from "../domain/types";
import { loadHandoffSettings } from "./config-repository";
import {
	captureTerminalContext,
	sendEnter,
	type TerminalContext,
} from "./terminal-strategy";

/**
 * Delay (ms) after agent_settled before sending Enter. Gives the TUI time to
 * settle and render the pre-filled editor text.
 */
const AUTO_SUBMIT_DELAY_MS = 200;

/**
 * Safety timeout (ms) to auto-clear the pending flag if agent_settled never
 * fires (e.g. agent crashed, user interrupted). Prevents a stale flag from
 * triggering on an unrelated future agent_settled.
 */
const PENDING_FLAG_TIMEOUT_MS = 30_000;

/**
 * Terminal context captured at tui_filled_handoff emit time. When non-null,
 * an auto-submit is pending and will fire on the next agent_settled.
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

		// The origin record is written by createHandoffSession via
		// sm.appendMessage({role: "custom", …}) — a `type: "message"` entry
		// carrying `message.customType` + `message.details` (D8). The old
		// `e.type === "custom"` predicate matched a shape this extension never
		// writes, so this notify never fired.
		const entries = ctx.sessionManager.getEntries();
		const originEntry = entries.find(
			(e): e is Extract<SessionEntry, { type: "message" }> =>
				e.type === "message" &&
				e.message.role === "custom" &&
				e.message.customType === "handoff-origin",
		);

		if (!originEntry) return;

		const message = originEntry.message;
		const data =
			message.role === "custom"
				? (message.details as HandoffOriginData | undefined)
				: undefined;
		const goalHint = data?.goal ? `: ${data.goal.slice(0, 50)}` : "";
		const originHints = [
			data?.profile,
			data?.parentSession ? basename(data.parentSession) : undefined,
		]
			.filter((part): part is string => Boolean(part))
			.join(", ");
		ctx.ui.notify(
			`↩ Continued from previous session${goalHint}${originHints ? ` (${originHints})` : ""}`,
			"info",
		);
	});

	// ── tui_filled_handoff: capture terminal context for auto-submit ────────

	pi.events.on("tui_filled_handoff", async () => {
		const settings = loadHandoffSettings();
		const ctx = await captureTerminalContext(settings?.terminal);
		if (!ctx) return;

		pendingAutoSubmit = ctx;

		// Safety: clear the flag after a timeout in case agent_settled never fires.
		if (pendingFlagTimer) clearTimeout(pendingFlagTimer);
		pendingFlagTimer = setTimeout(
			() => clearPendingAutoSubmit(),
			PENDING_FLAG_TIMEOUT_MS,
		);
	});

	// ── agent_settled: auto-submit Enter if a handoff is pending ────────────

	pi.on("agent_settled", () => {
		if (pendingAutoSubmit === null) return;

		const ctx = pendingAutoSubmit;
		clearPendingAutoSubmit();

		// Small delay for the TUI to render the pre-filled editor text.
		setTimeout(() => {
			sendEnter(ctx);
		}, AUTO_SUBMIT_DELAY_MS);
	});

	// ── session_shutdown: release pending auto-submit state ────────
	// pi 1.0 extensions.md ("Errors and cleanup"): release resources in
	// session_shutdown and keep cleanup idempotent; quit, reload, and session
	// replacement can converge here. clearPendingAutoSubmit() is a no-op when
	// nothing is pending, so running it twice is safe.

	pi.on("session_shutdown", () => {
		clearPendingAutoSubmit();
	});
}
