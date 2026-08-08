/**
 * /handoff command.
 *
 * Interactive slash command that transfers context to a new focused session.
 * Supports quick mode (`/handoff! goal`) which skips the editor review step.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { loadHandoffSettings } from "../infrastructure/config-repository";
import { executeHandoff } from "../application/handoff-executor";

export function registerHandoffCommand(pi: ExtensionAPI): void {
	pi.registerCommand("handoff", {
		description:
			"Transfer context to a new session. Prepend ! for quick mode (skip editor). Goal optional.",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const settings = loadHandoffSettings();
			await executeHandoff(pi, ctx, { rawArgs: args.trim() }, settings);
		},
	});
}
