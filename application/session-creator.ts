/**
 * Session creation application service.
 *
 * Creates the new session for the unified continuation flow — called by
 * commands/continue.ts (`/continue`: the bare handoff recovery and the
 * generic text form) and application/handoff-executor.ts (the cold-path
 * direct launch). The live first message IS the handoff document —
 * provenance line + full PA-stripped body + canonical Phase Adherence
 * composed by `buildContinuationPrompt` (no-doc rehaul, D11).
 *
 * Handles: labeling the old session's leaf, recording the handoff origin
 * (including the full document in `details` — never serialized to the LLM),
 * and sending the initial message.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { HandoffOriginData } from "../domain/types";
import { resolvePiAgentDir } from "../infrastructure/config-repository";

/**
 * Identity of the CURRENT (handing-off) session needed to create its child.
 * A full GatheredContext is deliberately NOT required — the in-session launch
 * path must not pay for a context re-gather.
 */
export interface CurrentSessionRef {
	currentSessionFile: string | undefined;
	leafId: string | null;
}

/**
 * Create the new handoff session with the live first message and a hidden
 * `handoff-origin` entry recording the parent session + the handoff
 * document (in `details` — the durable audit trail).
 *
 * Returns `"ok"` on success, `"cancelled"` if the user cancelled, or
 * throws on error.
 */
export async function createHandoffSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	session: CurrentSessionRef,
	opts: {
		goal: string | null;
		sessionTitle: string;
		liveMessage: string;
		/**
		 * Full PA-stripped handoff document with its provenance line — recorded
		 * in the hidden `handoff-origin` entry's `details` as the durable audit
		 * trail. `details` is never serialized to the LLM (only `content`
		 * becomes a user message), so the document rides exactly once — in the
		 * visible live message. Omitted for generic (`/continue <text>`) launches.
		 */
		document?: string;
	},
): Promise<"ok" | "cancelled"> {
	const { goal, sessionTitle, liveMessage, document } = opts;
	const currentSessionFile = session.currentSessionFile;

	// Label the handoff point in the OLD session
	if (session.leafId) {
		try {
			pi.setLabel(session.leafId, `handoff → ${sessionTitle}`);
		} catch {
			// not critical
		}
	}

	const newSessionResult = await ctx.newSession({
		parentSession: currentSessionFile,

		setup: async (sm) => {
			sm.appendSessionInfo(sessionTitle);

			sm.appendMessage({
				role: "custom",
				customType: "handoff-origin",
				content: `Handed off from: ${currentSessionFile ?? "unknown session"}`,
				display: false,
				details: {
					parentSession: currentSessionFile,
					goal,
					timestamp: Date.now(),
					document,
					// D8: agent dir at creation time — the only profile signal
					// the extension has (no profile API exists).
					profile: resolvePiAgentDir(),
				} satisfies HandoffOriginData,
				timestamp: Date.now(),
			});
		},

		withSession: async (replacementCtx) => {
			await replacementCtx.sendUserMessage(liveMessage);
			replacementCtx.ui.notify("Handoff started", "info");
		},
	});

	return newSessionResult.cancelled ? "cancelled" : "ok";
}
