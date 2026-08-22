/**
 * Terminal strategy — abstracts the multiplexer selection (tmux vs herdr).
 *
 * Given the handoff settings and runtime environment, determines which
 * terminal multiplexer to use for auto-submit and provides a unified
 * interface for capturing pane context and sending keystrokes.
 */

import type { TerminalMode, HerdrPaneContext } from "../domain/types";
import {
	isTmuxSession,
	getCurrentTmuxPaneId,
	sendEnterToPane as tmuxSendEnter,
} from "./tmux-client";
import {
	isHerdrSession,
	getHerdrPaneContext,
	saveHerdrContext,
	sendEnterToPane as herdrSendEnter,
} from "./herdr-client";

/**
 * Resolved terminal context — captures everything the auto-submit listener
 * needs to send Enter to the correct pane after the agent turn ends.
 */
export interface TerminalContext {
	/** Which multiplexer is active. */
	mode: TerminalMode;
	/** Opaque pane handle for sending keystrokes (tmux "%5" or herdr "w1:p1"). */
	paneId: string;
	/** Herdr coordinates, if available (only when mode is "herdr"). */
	herdr?: HerdrPaneContext;
}

/**
 * Determine the effective terminal mode based on config and environment.
 *
 * Falls back gracefully: if the configured mode's environment isn't active,
 * returns null so the caller can skip auto-submit.
 */
export function resolveTerminalMode(
	configured?: TerminalMode,
): TerminalMode | null {
	// Explicit config wins.
	if (configured === "herdr") {
		return isHerdrSession() ? "herdr" : null;
	}
	if (configured === "tmux") {
		return isTmuxSession() ? "tmux" : null;
	}

	// No config — auto-detect from environment.
	if (isHerdrSession()) return "herdr";
	if (isTmuxSession()) return "tmux";
	return null;
}

/**
 * Capture the terminal context at a specific point in time.
 *
 * Should be called at the START of the handoff flow (before async work like
 * LLM generation) so the pane id is stable even if the user switches tabs.
 */
export async function captureTerminalContext(
	configured?: TerminalMode,
): Promise<TerminalContext | null> {
	const mode = resolveTerminalMode(configured);
	if (!mode) return null;

	if (mode === "herdr") {
		const herdr = getHerdrPaneContext();
		if (!herdr) return null;
		await saveHerdrContext(herdr);
		return { mode, paneId: herdr.paneId, herdr };
	}

	// tmux
	const paneId = getCurrentTmuxPaneId();
	if (!paneId) return null;
	return { mode, paneId };
}

/**
 * Send the Enter key to a pane via the appropriate multiplexer.
 */
export function sendEnter(ctx: TerminalContext): boolean {
	if (ctx.mode === "herdr") {
		return herdrSendEnter(ctx.paneId);
	}
	return tmuxSendEnter(ctx.paneId);
}
