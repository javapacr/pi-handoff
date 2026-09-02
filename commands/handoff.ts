/**
 * /handoff command — detached mode (default, `handoff.type` unset or
 * "detached").
 *
 * Interactive slash command that transfers context to a new focused session.
 * Supports quick mode (`/handoff! goal`) which skips the editor review step.
 *
 * The generation itself is delegated to the untouched detached executor
 * (application/handoff-executor.ts): serialize session → one-off LLM call →
 * editor review → new session.
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
			"Transfer context to a new session. Prepend ! for quick mode (skip editor). Goal optional.",
		handler: async (args, ctx: ExtensionCommandContext) => {
			await executeHandoff(pi, ctx, { rawArgs: args.trim() }, settings);
		},
	});
}
