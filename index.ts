/**
 * Handoff extension — transfer context to a new focused session.
 *
 * Entry point that wires together tools, commands, and event hooks.
 *
 * `handoff.type` in settings.json selects ONE of two registration paths at
 * startup. Changing the toggle requires a session restart.
 *
 * - "detached" (default): `/handoff` serializes the session and generates the
 *   doc in a one-off LLM call (honours provider/model/effort), then creates
 *   the new session. `request_handoff` lets the agent trigger that flow.
 * - "in-session": NO /handoff — the shipped `pi-handoff` skill is the
 *   instruction source; when the user asks for a handoff, the agent writes
 *   the doc itself (prompt-cache-aligned: the session model IS the
 *   summarizer) and calls the `continue` tool, which fills the TUI input
 *   with `/continue <docPath>`.
 *
 * The pi-handoff skill is the primary instruction source for agents
 * performing handoffs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadHandoffSettings } from "./infrastructure/config-repository";
import { registerRequestHandoffTool } from "./tools/request-handoff";
import { registerContinueTool } from "./tools/continue";
import { registerHandoffCommandDetached } from "./commands/handoff";
import { registerContinueCommand } from "./commands/continue";
import { registerHandoffEvents } from "./infrastructure/event-registration";

export default function handoffExtension(pi: ExtensionAPI): void {
	registerHandoffEvents(pi);

	const settings = loadHandoffSettings();
	if (settings?.type === "in-session") {
		registerContinueCommand(pi);
		registerContinueTool(pi);
	} else {
		registerHandoffCommandDetached(pi, settings);
		registerRequestHandoffTool(pi);
	}
}
