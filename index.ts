/**
 * Handoff extension — transfer context to a new focused session.
 *
 * Entry point that wires together tools, commands, and event hooks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRequestHandoffTool } from "./tools/request-handoff";
import { registerHandoffCommand } from "./commands/handoff";
import { registerHandoffEvents } from "./infrastructure/event-registration";

export default function handoffExtension(pi: ExtensionAPI): void {
	registerHandoffEvents(pi);
	registerRequestHandoffTool(pi);
	registerHandoffCommand(pi);
}
