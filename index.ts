/**
 * Handoff extension — transfer context to a new focused session.
 *
 * Entry point that wires together tools, commands, and event hooks.
 *
 * `handoff.type` in settings.json selects ONE of two registration paths at
 * startup (no mode-branching inside handlers — each registration owns one
 * flow). Changing the toggle requires a session restart.
 *
 * - "detached" (default): serialize the session, generate the doc in a
 *   one-off LLM call, editor review, create the new session.
 * - "in-session": inject an instruction turn into the live session; the
 *   session's own model writes the doc (prompt-cache-aligned) and calls the
 *   `continue` tool, which fills the TUI input with `/continue <docPath>`.
 *
 * The pi-handoff skill (shipped via the manifest) is the primary instruction
 * source for agents performing handoffs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadHandoffSettings } from "./infrastructure/config-repository";
import { registerRequestHandoffTool } from "./tools/request-handoff";
import { registerContinueTool } from "./tools/continue";
import { registerHandoffCommandDetached } from "./commands/handoff";
import { registerHandoffCommandInSession } from "./commands/handoff-in-session";
import { registerContinueCommand } from "./commands/continue";
import { registerHandoffEvents } from "./infrastructure/event-registration";

export default function handoffExtension(pi: ExtensionAPI): void {
	registerHandoffEvents(pi);

	const settings = loadHandoffSettings();
	if (settings?.type === "in-session") {
		registerHandoffCommandInSession(pi, settings);
		registerContinueCommand(pi);
		registerContinueTool(pi);
		registerRequestHandoffTool(pi, { mode: "in-session" });
	} else {
		registerHandoffCommandDetached(pi, settings);
		registerRequestHandoffTool(pi, { mode: "detached" });
	}
}
