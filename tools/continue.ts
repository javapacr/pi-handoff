/**
 * continue tool — stages bare `/continue` for the skill flow (no-doc rehaul,
 * design D10).
 *
 * The FINAL step of the handoff: the agent calls it with the complete filled
 * handoff template as the `document` argument — full text inline, nothing on
 * disk. The tool validates the document (non-empty `## Next Task` section),
 * normalizes it (strips a trailing `## Phase Adherence` — the canonical copy
 * is appended exactly once at launch), and stages bare `/continue` in the TUI
 * editor. The tool call itself is the document stash: `arguments.document` is
 * durably in the session branch/JSONL the moment the tool executes, and bare
 * `/continue` recovers it at launch.
 *
 * The tool does NOT create the session (newSession is command-context-only)
 * and writes NOTHING to the filesystem. On validation failure it returns an
 * isError result telling the agent exactly what to repair — the self-healing
 * loop re-calls with the corrected document. After a success the agent STOPS;
 * the launch happens on turn end (herdr/tmux auto-submit) or via Enter.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TuiFilledHandoffPayload } from "../domain/types";
import {
	deriveSessionTitle,
	findNextTaskContent,
	stripTrailingPhaseAdherence,
} from "../domain/handoff-prompt";
import { buildProvenanceLine } from "../domain/provenance";
import { resolveTerminalMode } from "../infrastructure/terminal-strategy";

export interface ContinueDetails {
	sessionTitle?: string;
	suggestedCommand?: string;
	/** Provenance line computed at staging time — `/continue` recomputes its own at launch. */
	provenanceLine?: string;
	/** The normalized (PA-stripped) document that will seed the new session. */
	document?: string;
}

function errorResult(text: string, document?: string) {
	return {
		content: [{ type: "text" as const, text }],
		isError: true,
		details: { document } satisfies ContinueDetails,
	};
}

export function registerContinueTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "continue",
		label: "Continue in New Session",
		description:
			"Queue the handoff launch. This is the LAST step of the handoff: " +
			"call it with the complete filled handoff template as `document` — " +
			"the full text inline; nothing is written to disk and no file path " +
			"is involved. It validates the document (non-empty ## Next Task " +
			"section) and stages the /continue command that launches the new " +
			"session. On failure it reports what to repair — fix the document " +
			"text and call it again with the corrected full document. After a " +
			"success, stop: no further tool calls, one short line at most.",
		promptSnippet: "Stage /continue — queues the new-session launch",
		promptGuidelines: [
			"Call continue with the complete filled handoff template as the document argument (full text inline, no file).",
			"If the tool reports the document is invalid, fix the document text and call it again with the full corrected document.",
			"After a successful continue call, stop — /continue is filled in the TUI; the user (or auto-submit) confirms it.",
		],
		parameters: {
			type: "object" as const,
			properties: {
				document: {
					type: "string",
					description:
						"The complete filled handoff template, full text inline (per the pi-handoff skill's document contract).",
				},
			},
			required: ["document"],
		} as any,
		async execute(
			_toolCallId,
			params: { document?: string },
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		) {
			const rawDocument = params.document;
			if (typeof rawDocument !== "string" || rawDocument.trim().length === 0) {
				return errorResult(
					`No handoff document provided. Call continue again with ` +
						`{"document": "<the complete filled handoff template>"} — the ` +
						`full text inline. Nothing is written to disk; there is no ` +
						`file or path involved.`,
				);
			}

			const task = findNextTaskContent(rawDocument);
			if (task === null) {
				return errorResult(
					`Invalid handoff document: it has no non-empty ` +
						`\`## Next Task\` section. Fix the DOCUMENT text so it contains ` +
						`a \`## Next Task\` heading followed by the actual work for the ` +
						`new session, then call continue again with the full corrected ` +
						`document. Write the document WITHOUT a \`## Phase Adherence\` ` +
						`section — the extension appends the canonical copy at launch.`,
					rawDocument,
				);
			}

			// Normalize: the canonical Phase Adherence is appended exactly once
			// at launch — a model-authored trailing variant must not ride along
			// in the body. In-memory only; arguments.document keeps the raw text
			// and /continue strips again (idempotent) at recovery.
			const document = stripTrailingPhaseAdherence(rawDocument);

			// Provenance line computed here for the staging record — the launch
			// RECOMPUTES it, so this must stay pure (no tmp+rename stamp; the
			// tool performs zero filesystem writes).
			const provenanceLine = buildProvenanceLine(
				ctx.sessionManager.getSessionFile(),
			);

			const sessionTitle = deriveSessionTitle(null, task);
			const command = "/continue";

			ctx.ui.setEditorText(command);

			// Notify the auto-submit listener: it sends Enter to the pane after
			// the agent turn ends (herdr/tmux).
			pi.events.emit("tui_filled_handoff", {
				goal: sessionTitle,
				command,
			} satisfies TuiFilledHandoffPayload);

			const mode = resolveTerminalMode();
			const autoSubmitLabel =
				mode === "herdr"
					? "The launch auto-submits via herdr on turn end."
					: mode === "tmux"
						? "The launch auto-submits via tmux on turn end."
						: "The user presses Enter to run it.";

			return {
				content: [
					{
						type: "text" as const,
						text: `Handoff staged (${sessionTitle}) — /continue is pre-filled. The new session launches on turn end (auto-submit) or via Enter, seeded with your document and its Next Task. ${autoSubmitLabel} Stop now: no further tool calls, one short line at most.`,
					},
				],
				details: {
					sessionTitle,
					suggestedCommand: command,
					provenanceLine,
					document,
				} satisfies ContinueDetails,
			};
		},
	});
}
