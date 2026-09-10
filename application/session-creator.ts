/**
 * Session creation application service.
 *
 * Creates the new session for the unified continuation flow — called ONLY by
 * commands/continue.ts (`/continue` and the staged command from the `continue`
 * tool). The live first message embeds the handoff document path plus an
 * explicit read-first instruction; the document body is NOT pre-loaded (docs
 * can be large), the new session pulls the content from disk on demand.
 *
 * Handles: labeling the old session's leaf, recording the handoff origin
 * (including the doc path), and sending the initial message.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { HandoffOriginData } from "../domain/types";

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
 * `handoff-origin` entry recording the parent session + document path.
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
		 * Handoff document path — recorded in the hidden `handoff-origin`
		 * entry's `details` so session_start can report the origin. The path
		 * itself travels in the visible live message (via
		 * `buildContinuationPrompt`), not as a seeded reference.
		 */
		artifactPath?: string;
	},
): Promise<"ok" | "cancelled"> {
	const { goal, sessionTitle, liveMessage, artifactPath } = opts;
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
					docPath: artifactPath,
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
