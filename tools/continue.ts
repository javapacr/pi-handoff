/**
 * continue tool — in-session mode only.
 *
 * The FINAL step of the handoff: the agent calls it after the handoff
 * document is written and complete on disk. Validates the document — a
 * non-empty `## Next Task` section — and fills the TUI input with the
 * `/continue <docPath>` command. Same prefill/terminal strategy as
 * `request_handoff`: `ctx.ui.setEditorText` + `tui_filled_handoff`, so the
 * herdr/tmux auto-submit listener sends Enter after the turn ends and the
 * `/continue` command pushes everything into the next session.
 *
 * On validation failure the tool returns an isError result telling the agent
 * exactly what to repair — the self-healing loop re-runs until the doc is
 * valid or the user aborts. After a success the agent STOPS; the launch is
 * queued.
 */

import { promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TuiFilledHandoffPayload } from "../domain/types";
import {
	buildContinuationPrompt,
	deriveSessionTitle,
	findNextTaskContent,
} from "../domain/handoff-prompt";
import { resolveTerminalMode } from "../infrastructure/terminal-strategy";

export interface ContinueDetails {
	docPath: string;
	sessionTitle?: string;
	suggestedCommand?: string;
	/** The exact live message the new session will receive (Next Task + canonical Phase Adherence). */
	liveMessage?: string;
}

function errorResult(text: string, docPath: string) {
	return {
		content: [{ type: "text" as const, text }],
		isError: true,
		details: { docPath } satisfies ContinueDetails,
	};
}

export function registerContinueTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "continue",
		label: "Continue in New Session",
		description:
			"Fill the TUI input with the `/continue <docPath>` command once the " +
			"handoff document is completed on disk. This is the LAST step of the " +
			"handoff: call it only after the file is written, with the exact docPath " +
			"from the handoff instruction. It validates the document (non-empty " +
			"## Next Task section) and queues the new-session launch. On failure it " +
			"reports what to repair — fix the file and call it again. After a " +
			"success, stop: no further tool calls, one short line at most.",
		promptSnippet: "Fill TUI with /continue — queues the new-session launch",
		promptGuidelines: [
			"Call continue with the exact docPath from the handoff instruction, only after the handoff document is written and complete.",
			"If the tool reports the document is invalid, fix the reported problem in the file and call it again.",
			"After a successful continue call, stop — the launch command is filled in the TUI; the user (or auto-submit) confirms it.",
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
						`already exists), then call continue again.`,
					docPath,
				);
			}

			const liveMessage = buildContinuationPrompt(doc);
			if (liveMessage === null) {
				return errorResult(
					`Invalid handoff document at ${docPath}: it has no non-empty ` +
						`"## Next Task" section. Repair the file so it ends with a ` +
						`\`## Next Task\` heading followed by the actual work for the new ` +
						`session, then call continue again. The canonical \`## Phase ` +
						`Adherence\` section is added automatically — do not write it yourself.`,
					docPath,
				);
			}

			const sessionTitle = deriveSessionTitle(
				null,
				findNextTaskContent(doc) ?? "",
			);
			const command = `/continue ${docPath}`;

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
						text: `Handoff document validated (${sessionTitle}). /continue pre-filled in the input box — the next session will start with this document's Next Task. ${autoSubmitLabel}`,
					},
				],
				details: {
					docPath,
					sessionTitle,
					suggestedCommand: command,
					liveMessage,
				} satisfies ContinueDetails,
			};
		},
	});
}
