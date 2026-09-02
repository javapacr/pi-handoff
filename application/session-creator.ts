/**
 * Session creation application service.
 *
 * Shared by both handoff modes: creates the new session with a handoff
 * document REFERENCE and a live first message.
 *
 * The handoff document is NOT pre-loaded into the session — docs can be
 * large. The new session receives the document path plus an explicit
 * instruction to read it, and pulls the content from disk on demand.
 *
 * - detached: called by application/handoff-executor.ts after prompt
 *   generation + editor review.
 * - in-session: called by the `/continue <docPath>` command that the
 *   `continue` tool pre-fills.
 *
 * Handles: labeling the old session's leaf, seeding the document reference,
 * and sending the initial message.
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
 * Create the new handoff session with a document reference and live message.
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
		/** Handoff document path — seeded as a read-first reference + origin marker. */
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

			if (artifactPath) {
				sm.appendMessage({
					role: "user",
					content: [
						{
							type: "text",
							text:
								`## Handoff Context (previous session)\n\n` +
								`Handoff document: ${artifactPath}\n\n` +
								`This file contains the previous session's full handoff ` +
								`document (what was done, git state, active tasks, suggested ` +
								`skills, working directory). READ it with the read tool before ` +
								`acting on the task in the message that follows this one.`,
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
