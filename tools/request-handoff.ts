/**
 * request_handoff tool.
 *
 * LLM-callable tool that suggests a session handoff to the user by pre-filling
 * `/handoff <goal>` in the TUI input editor. The tool cannot create a new
 * session itself because `execute()` handlers receive `ExtensionContext`, while
 * `newSession()` lives only on `ExtensionCommandContext` used by slash-command
 * handlers.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TuiFilledHandoffPayload } from "../domain/types";
import { isTmuxSession } from "../infrastructure/tmux-client";

export interface RequestHandoffDetails {
	goal: string;
	suggestedCommand: string;
}

export function registerRequestHandoffTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "request_handoff",
		label: "Request Handoff",
		description:
			"Pre-fill the `/handoff <goal>` command in the TUI input editor. " +
			"This is a fire-and-forget trigger — it only sets the editor text and stops. " +
			"Do NOT research, summarize, or prepare context. The /handoff command itself " +
			"gathers all context and generates the handoff prompt. Just pass the goal " +
			"verbatim and stop.",
		promptSnippet: "Pre-fill /handoff command — no research needed",
		promptGuidelines: [
			"Call request_handoff with a short goal string (verbatim from the user or current task).",
			"Do NOT research, summarize, or gather context before calling — /handoff handles all context transfer.",
			"After calling request_handoff, stop. The tool just pre-fills the command; the user presses Enter to run it.",
		],
		parameters: {
			type: "object" as const,
			properties: {
				goal: {
					type: "string",
					description:
						"Short goal for the next session. Pass verbatim — do not research or elaborate.",
				},
			},
			required: ["goal"],
		} as any,
		async execute(
			_toolCallId,
			params: { goal: string },
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		) {
			const command = `/handoff ${params.goal}`;
			ctx.ui.setEditorText(command);

			// Notify the auto-submit listener. If running inside tmux, the
			// listener will send Enter to the pane after the agent turn ends.
			pi.events.emit("tui_filled_handoff", {
				goal: params.goal,
				command,
			} satisfies TuiFilledHandoffPayload);

			return {
				content: [
					{
						type: "text" as const,
						text: isTmuxSession()
							? `Handoff command pre-filled and auto-submitting via tmux…`
							: `Handoff command pre-filled in the input box. Press Enter to run it.`,
					},
				],
				details: {
					goal: params.goal,
					suggestedCommand: command,
				} as RequestHandoffDetails,
			};
		},
	});
}
