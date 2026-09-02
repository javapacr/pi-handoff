/**
 * handoff_launch tool — in-session mode only.
 *
 * Called by the live agent after it writes the handoff document (path given
 * in the injected instruction turn). Validates the document — specifically a
 * non-empty `## Next Task` section — and on success pre-fills the TUI input
 * with the `/handoff-launch <docPath>` command. Same prefill/terminal
 * strategy as `request_handoff`: `ctx.ui.setEditorText` + `tui_filled_handoff`
 * so the herdr/tmux auto-submit listener sends Enter after the turn ends.
 *
 * On validation failure the tool returns an isError result telling the agent
 * exactly what to repair — the self-healing loop re-runs until the doc is
 * valid or the user aborts.
 */

import { promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TuiFilledHandoffPayload } from "../domain/types";
import { deriveSessionTitle, findNextTaskSection } from "../domain/handoff-prompt";
import { resolveTerminalMode } from "../infrastructure/terminal-strategy";

export interface HandoffLaunchDetails {
	docPath: string;
	sessionTitle?: string;
	suggestedCommand?: string;
}

function errorResult(text: string, docPath: string) {
	return {
		content: [{ type: "text" as const, text }],
		isError: true,
		details: { docPath } satisfies HandoffLaunchDetails,
	};
}

export function registerHandoffLaunchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "handoff_launch",
		label: "Handoff Launch",
		description:
			"Validate a handoff document and queue the new-session launch. " +
			"Call this after writing the handoff document, with the docPath exactly " +
			"as given in the handoff instruction. The tool checks the document for a " +
			"non-empty ## Next Task section and pre-fills the new-session launch " +
			"command in the TUI input editor. On failure it reports what to repair — " +
			"fix the file and call it again. Do not call it for any other purpose.",
		promptSnippet: "Validate handoff doc and queue the new-session launch",
		promptGuidelines: [
			"Call handoff_launch with the exact docPath from the handoff instruction, immediately after writing the handoff document.",
			"If the tool reports the document is invalid, fix the reported problem in the file and call it again.",
			"After a successful handoff_launch, stop — the launch command is pre-filled; the user confirms it.",
		],
		parameters: {
			type: "object" as const,
			properties: {
				docPath: {
					type: "string",
					description:
						"Path to the handoff document, exactly as given in the handoff instruction.",
				},
			},
			required: ["docPath"],
		} as any,
		async execute(
			_toolCallId,
			params: { docPath: string },
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		) {
			const docPath = isAbsolute(params.docPath)
				? params.docPath
				: join(ctx.cwd, params.docPath);

			let doc: string;
			try {
				doc = await fs.readFile(docPath, "utf8");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return errorResult(
					`Handoff document not readable at ${docPath}: ${message}. ` +
						`Write the handoff document to that exact path (the parent directory ` +
						`already exists), then call handoff_launch again.`,
					docPath,
				);
			}

			const nextTask = findNextTaskSection(doc);
			if (nextTask === null) {
				return errorResult(
					`Invalid handoff document at ${docPath}: it has no non-empty ` +
						`"## Next Task" section. Repair the file so it ends with a ` +
						`\`## Next Task\` heading followed by a clear, actionable statement ` +
						`of the goal for the new session (and \`## Phase Adherence\` as the ` +
						`final section), then call handoff_launch again.`,
					docPath,
				);
			}

			const sessionTitle = deriveSessionTitle(null, nextTask);
			const command = `/handoff-launch ${docPath}`;

			ctx.ui.setEditorText(command);

			// Notify the auto-submit listener: it sends Enter to the pane after
			// the agent turn ends (herdr/tmux), same as request_handoff.
			pi.events.emit("tui_filled_handoff", {
				goal: sessionTitle,
				command,
			} satisfies TuiFilledHandoffPayload);

			const mode = resolveTerminalMode();
			const autoSubmitLabel =
				mode === "herdr"
					? "auto-submitting via herdr…"
					: mode === "tmux"
						? "auto-submitting via tmux…"
						: "Press Enter to run it.";

			return {
				content: [
					{
						type: "text" as const,
						text: `Handoff document validated (${sessionTitle}). New-session launch command pre-filled in the input box. ${autoSubmitLabel}`,
					},
				],
				details: {
					docPath,
					sessionTitle,
					suggestedCommand: command,
				} satisfies HandoffLaunchDetails,
			};
		},
	});
}
