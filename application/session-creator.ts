/**
 * Session creation application service.
 *
 * Shared by both handoff modes: creates the new session with pre-seeded
 * handoff context and a live first message.
 *
 * - detached: called by application/handoff-executor.ts after prompt
 *   generation + editor review.
 * - in-session: called by the `/continue <docPath>` command that the
 *   `continue` tool pre-fills.
 *
 * Handles: labeling the old session's leaf, setting up the new session with
 * the handoff context block + origin marker, and sending the initial message.
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
 * Create the new handoff session with pre-seeded context and live message.
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
		contextBlock: string;
		liveMessage: string;
	},
): Promise<"ok" | "cancelled"> {
	const { goal, sessionTitle, contextBlock, liveMessage } = opts;
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

			if (contextBlock) {
				sm.appendMessage({
					role: "user",
					content: [
						{
							type: "text",
							text: `## Handoff Context (previous session)\n\n${contextBlock}`,
						},
					],
					timestamp: Date.now() - 1000,
				});
			}

			sm.appendMessage({
				role: "custom",
				customType: "handoff-origin",
				content: `Handed off from: ${currentSessionFile ?? "unknown session"}`,
				display: false,
				details: {
					parentSession: currentSessionFile,
					goal,
					timestamp: Date.now(),
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
