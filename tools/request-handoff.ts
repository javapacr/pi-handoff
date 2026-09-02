/**
 * request_handoff tool.
 *
 * LLM-callable tool that suggests a session handoff to the user by pre-filling
 * `/handoff <goal>` in the TUI input editor. The tool cannot create a new
 * session itself because `execute()` handlers receive `ExtensionContext`, while
 * `newSession()` lives only on `ExtensionCommandContext` used by slash-command
 * handlers.
 *
 * Emits lifecycle events on the event bus so other extensions can react to
 * handoff tool invocations.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TuiFilledHandoffPayload } from "../domain/types";
import { resolveTerminalMode } from "../infrastructure/terminal-strategy";
import { emitToolStart, emitToolEnd } from "../infrastructure/event-channels";

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
			"verbatim and stop. " +
			"Running /handoff generates the prompt in a detached LLM call and creates the new session. " +
			"(Detached mode only — this tool is not registered in in-session mode.)",
		// Mechanics are mode-agnostic — the pre-registered /handoff command
		// handler owns whatever the mode does; this tool just types the command.
		promptSnippet: "Pre-fill /handoff command — no research needed",
		promptGuidelines: [
			"Call request_handoff with a short goal string (verbatim from the user or current task).",
			"Do NOT research, summarize, or gather context before calling — /handoff handles all context transfer.",
			"After calling request_handoff, stop. The tool just pre-fills the command; the user presses Enter to run it.",
			"If this session produced durable learnings not yet recorded in your memory diary, consider writing a diary entry (mempalace_diary_write) before calling this tool.",
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

			// Emit lifecycle: tool started
			emitToolStart(pi, { goal: params.goal, command });

			ctx.ui.setEditorText(command);

			// Notify the auto-submit listener. If running inside a supported
			// terminal multiplexer, the listener will send Enter to the pane
			// after the agent turn ends.
			pi.events.emit("tui_filled_handoff", {
				goal: params.goal,
				command,
			} satisfies TuiFilledHandoffPayload);

			const mode = resolveTerminalMode();
			const autoSubmitLabel =
				mode === "herdr"
					? "auto-submitting via herdr…"
					: mode === "tmux"
						? "auto-submitting via tmux…"
						: "Press Enter to run it.";

			// Emit lifecycle: tool completed
			emitToolEnd(pi, { goal: params.goal, command });

			return {
				content: [
					{
						type: "text" as const,
						text: `Handoff command pre-filled in the input box. ${autoSubmitLabel}`,
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
