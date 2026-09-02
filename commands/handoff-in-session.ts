/**
 * /handoff command — in-session mode (`handoff.type: "in-session"`).
 *
 * Instead of serializing the session and generating the handoff doc in a
 * detached LLM call, this mode injects ONE instruction turn into the LIVE
 * session. The session's own model — with the full conversation already in
 * its context window — writes the handoff document to
 * `$PI_CODING_AGENT_DIR/data/pi-handoff/handoff-<timestamp>.md` and then calls
 * the `handoff_launch` tool, which validates the doc and pre-fills the
 * new-session launch command.
 *
 * Cost rationale: when the summarizer IS the session model (e.g. Sonnet-only
 * work profile), this turn is prompt-cache-aligned by construction — the full
 * history is read at cache rates instead of being re-sent at input rates by a
 * detached call. `provider`/`model`/`effort` settings are deliberately
 * ignored in this mode.
 *
 * No compaction is suggested here (unlike detached): compacting first would
 * replace the warm full-history prefix that makes this mode cheap.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { HandoffSettings } from "../domain/types";
import {
	HANDOFF_CRITICAL_RULES,
	HANDOFF_OUTPUT_TEMPLATE,
	handoffGoalBlock,
} from "../domain/handoff-template";
import { hasDiaryTool } from "../application/diary-reminder";
import { hasHandoffableConversation } from "../infrastructure/session-adapter";
import { resolvePiAgentDir } from "../infrastructure/config-repository";
import { emitCommandStart, emitCommandComplete } from "../infrastructure/event-channels";

/** Data dir for handoff documents, under the pi agent dir. */
function handoffDataDir(): string {
	return join(resolvePiAgentDir(), "data", "pi-handoff");
}

/** Timestamped doc path, same format as the detached artifact name. */
export function newHandoffDocPath(): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(handoffDataDir(), `handoff-${timestamp}.md`);
}

/**
 * Build the instruction turn injected into the live session.
 *
 * Embeds the SAME output template the detached system prompt uses
 * (`domain/handoff-template.ts` is the single source of truth), plus the
 * redaction rules and the target file path.
 */
export function buildInSessionInstruction(opts: {
	goal: string | null;
	docPath: string;
	settings: HandoffSettings | null;
	hasDiaryTool: boolean;
}): string {
	const { goal, docPath, settings, hasDiaryTool: hasMemoryTool } = opts;

	const parts: string[] = [
		"[handoff] Produce the handoff document for this session now.",
		handoffGoalBlock(goal),
		"You are writing this document from live context — this session's conversation history, the current todo state, and the git working trees are your source material. Do not reproduce a raw transcript.",
		HANDOFF_CRITICAL_RULES,
	];

	if (settings?.diaryReminder !== false && hasMemoryTool) {
		parts.push(
			"Before writing the document: if this session produced durable learnings not yet recorded in long-term memory, write a MemPalace diary entry (mempalace_diary_write, AAAK format) first. Skip if you already wrote a diary entry for this session or there is nothing durable worth recording.",
		);
	}

	parts.push(
		`Write the document to this exact path:\n${docPath}\n\nThe parent directory already exists. The file must contain ONLY the document itself — no preamble, no closing remarks, no code fences.`,
		`Use exactly this output format — omit any section that has no content:\n\n${HANDOFF_OUTPUT_TEMPLATE}`,
		"IMPORTANT: Always end the document with ## Phase Adherence as the final section.",
		`When the file is written, call the \`handoff_launch\` tool with {"docPath": "${docPath}"}. It validates the document and pre-fills the new-session launch command in the TUI. If it reports a problem, fix the file and call it again. After handoff_launch succeeds, stop — no further tool calls, and keep any reply to one short line.`,
	);

	return parts.join("\n\n");
}

export function registerHandoffCommandInSession(
	pi: ExtensionAPI,
	settings: HandoffSettings | null,
): void {
	pi.registerCommand("handoff", {
		description:
			"Transfer context to a new session (generated inside this session). Goal optional.",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}

			// Parse goal the same way as detached (`/handoff! goal`); quick mode
			// itself is a no-op here — there is no editor review phase.
			const rawArgs = args.trim();
			const isQuick = rawArgs.startsWith("!");
			const goal = (isQuick ? rawArgs.slice(1).trim() : rawArgs) || null;

			// Same lifecycle ordering as the detached executor: commandStart
			// precedes the conversation gate; guard failures emit commandComplete
			// with an error so lifecycle consumers see paired events.
			emitCommandStart(pi, { goal, quickMode: isQuick });

			if (!hasHandoffableConversation(ctx)) {
				ctx.ui.notify("No conversation to hand off", "error");
				emitCommandComplete(pi, {
					goal,
					quickMode: isQuick,
					error: "No conversation to hand off",
				});
				return;
			}

			// Ensure the data dir exists so the agent can write the doc directly.
			const docPath = newHandoffDocPath();
			try {
				await fs.mkdir(handoffDataDir(), { recursive: true });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(
					`Cannot create handoff data dir: ${message}`,
					"error",
				);
				emitCommandComplete(pi, {
					goal,
					quickMode: isQuick,
					error: `Cannot create handoff data dir: ${message}`,
				});
				return;
			}

			const instruction = buildInSessionInstruction({
				goal,
				docPath,
				settings,
				hasDiaryTool: hasDiaryTool(pi),
			});

			// followUp queues behind a running turn; when idle it triggers one.
			pi.sendUserMessage(instruction, { deliverAs: "followUp" });

			ctx.ui.notify(
				"Handoff generation injected into this session — the agent will write the doc, then handoff_launch queues the new session",
				"info",
			);
		},
	});
}
