/**
 * /handoff command — cold path.
 *
 * Interactive slash command that transfers context to a new focused session:
 * snapshot → one-off flash-model call → in-memory validation → direct
 * session launch (application/handoff-executor.ts). No document file, no
 * editor review, no staging.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { HandoffSettings } from "../domain/types";
import { executeHandoff } from "../application/handoff-executor";

export function registerHandoffCommandDetached(
	pi: ExtensionAPI,
	settings: HandoffSettings | null,
): void {
	pi.registerCommand("handoff", {
		description:
			"Transfer context to a new session: snapshot this conversation, generate the handoff with the configured model, and launch it. Goal optional.",
		handler: async (args, ctx: ExtensionCommandContext) => {
			await executeHandoff(pi, ctx, { rawArgs: args.trim() }, settings);
		},
	});
}
