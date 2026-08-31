/**
 * Handoff execution application service.
 *
 * Orchestrates the full handoff flow from context gathering through prompt
 * review, splitting, labelling, and new-session creation.
 *
 * Supports both tmux and herdr backends for auto-submit via the terminal
 * strategy, and emits lifecycle events on the event bus.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type {
	HandoffOriginData,
	HandoffSettings,
	TuiHandoffCompletedPayload,
} from "../domain/types";
import {
	deriveSessionTitle,
	splitHandoffPrompt,
} from "../domain/handoff-prompt";
import type { GatheredContext } from "./context-gatherer";
import { generateHandoffPrompt } from "./prompt-generator";
import { gatherHandoffContext } from "./context-gatherer";
import { maybeRunDiaryReminder } from "./diary-reminder";
import {
	captureTerminalContext,
	type TerminalContext,
} from "../infrastructure/terminal-strategy";
import {
	emitCommandStart,
	emitCommandComplete,
} from "../infrastructure/event-channels";

export interface HandoffCommandArgs {
	rawArgs: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function maybeSuggestCompaction(
	ctx: ExtensionCommandContext,
): Promise<void> {
	const contextUsage = ctx.getContextUsage();
	if (contextUsage?.percent == null || contextUsage.percent <= 80) return;

	const compact = await ctx.ui.confirm(
		"High context usage",
		`Context is at ${contextUsage.percent.toFixed(0)}% ` +
			`(${(contextUsage.tokens ?? 0).toLocaleString()} tokens). ` +
			`Compact first for a tighter handoff?`,
	);

	if (!compact) return;

	await new Promise<void>((resolve) => {
		ctx.compact({
			onComplete: () => resolve(),
			onError: () => resolve(),
		});
	});
	ctx.ui.notify("Compaction done — continuing with handoff", "info");
}

/**
 * Copy text to the system clipboard (macOS pbcopy).
 * Best-effort — silently fails on unsupported platforms.
 */
function copyToClipboard(text: string): boolean {
	try {
		execSync("pbcopy", {
			input: text,
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 2000,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Print the handoff prompt to the terminal as a fallback when session
 * creation fails. Also copies to clipboard so the user can paste into a
 * new session manually.
 */
function printHandoffFallback(
	ctx: ExtensionCommandContext,
	prompt: string,
	artifactPath: string,
	error?: string,
): void {
	const reason = error ? `: ${error}` : "";
	ctx.ui.notify(
		`Handoff session creation failed${reason}. ` +
			`Prompt saved to ${artifactPath} and copied to clipboard.`,
		"warning",
	);

	copyToClipboard(prompt);

	process.stderr.write(
		`\n${"=".repeat(60)}\n` +
			`HANDOFF PROMPT (copy below into a new session)\n` +
			`${"=".repeat(60)}\n` +
			`${prompt}\n` +
			`${"=".repeat(60)}\n\n`,
	);
}

/**
 * Save the final handoff document to the OS temp directory.
 * Returns the file path, or null on failure.
 */
async function saveHandoffArtifact(finalPrompt: string): Promise<string> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const handoffDocPath = path.join(os.tmpdir(), `handoff-${timestamp}.md`);
	try {
		await fs.writeFile(handoffDocPath, finalPrompt, "utf-8");
		return handoffDocPath;
	} catch {
		return "";
	}
}

/**
 * Create the new handoff session with pre-seeded context and live message.
 *
 * Handles: labeling the old session, setting up the new session with
 * handoff context, and sending the initial message.
 *
 * Returns `"ok"` on success, `"cancelled"` if the user cancelled, or
 * throws on error.
 */
async function createHandoffSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	gathered: GatheredContext,
	opts: {
		goal: string | null;
		sessionTitle: string;
		contextBlock: string;
		liveMessage: string;
	},
): Promise<"ok" | "cancelled"> {
	const { goal, sessionTitle, contextBlock, liveMessage } = opts;
	const currentSessionFile = gathered.currentSessionFile;

	// Label the handoff point in the OLD session
	if (gathered.leafId) {
		try {
			pi.setLabel(gathered.leafId, `handoff → ${sessionTitle}`);
		} catch {
			// not critical
		}
	}

	const newSessionResult = await ctx.newSession({
		parentSession: currentSessionFile,

		setup: async (sm) => {
			sm.appendSessionInfo(sessionTitle);

			if (contextBlock) {
				sm.appendMessage({
					role: "user",
					content: [
						{
							type: "text",
							text: `## Handoff Context (previous session)\n\n${contextBlock}`,
						},
					],
					timestamp: Date.now() - 1000,
				});
			}

			sm.appendMessage({
				role: "custom",
				customType: "handoff-origin",
				content: `Handed off from: ${currentSessionFile ?? "unknown session"}`,
				display: false,
				details: {
					parentSession: currentSessionFile,
					goal,
					timestamp: Date.now(),
				} satisfies HandoffOriginData,
				timestamp: Date.now(),
			});
		},

		withSession: async (replacementCtx) => {
			await replacementCtx.sendUserMessage(liveMessage);
			replacementCtx.ui.notify("Handoff started", "info");
		},
	});

	return newSessionResult.cancelled ? "cancelled" : "ok";
}

// ── Main orchestrator ─────────────────────────────────────────────────────

export async function executeHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: HandoffCommandArgs,
	settings: HandoffSettings | null,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("handoff requires interactive mode", "error");
		return;
	}

	if (!ctx.model) {
		ctx.ui.notify("No model selected", "error");
		return;
	}

	// Parse quick mode: /handoff! goal
	const isQuick = args.rawArgs.startsWith("!");
	const goal = (isQuick ? args.rawArgs.slice(1).trim() : args.rawArgs) || null;

	emitCommandStart(pi, { goal, quickMode: isQuick });

	// Capture terminal context before async work (pane id must be stable)
	const terminalCtx: TerminalContext | null = await captureTerminalContext(
		settings?.terminal,
	);

	await maybeSuggestCompaction(ctx);

	const initial = gatherHandoffContext(ctx);
	if (!initial.hasConversation) {
		ctx.ui.notify("No conversation to hand off", "error");
		emitCommandComplete(pi, {
			goal,
			quickMode: isQuick,
			error: "No conversation to hand off",
		});
		return;
	}

	// Nudge the agent to persist durable learnings to MemPalace before the
	// handoff prompt is generated — while this session and its memory tools
	// are still live. Best-effort: never blocks or breaks the handoff.
	await maybeRunDiaryReminder(pi, ctx, settings);

	// Re-gather so the handoff snapshot includes the diary turn and the leaf
	// label lands on the true handoff point (the nudge appended entries).
	const gathered = gatherHandoffContext(ctx);

	const generated = await generateHandoffPrompt(
		ctx,
		{
			goal,
			conversationText: gathered.context.conversationText,
			todos: gathered.context.todos,
			git: gathered.context.git,
			skills: gathered.context.skills,
			cwd: gathered.context.cwd,
			contextUsage: gathered.context.contextUsage,
		},
		settings,
	);

	if (generated.error) {
		ctx.ui.notify(`Handoff failed: ${generated.error}`, "error");
		emitCommandComplete(pi, {
			goal,
			quickMode: isQuick,
			error: generated.error,
		});
		return;
	}

	if (generated.prompt === null || !generated.prompt.trim()) {
		const msg =
			generated.prompt === null ? "Cancelled" : "Empty response from model";
		if (generated.prompt === null) {
			ctx.ui.notify("Cancelled", "info");
		} else {
			ctx.ui.notify(
				"Handoff generation returned empty response — check model selection",
				"error",
			);
		}
		emitCommandComplete(pi, { goal, quickMode: isQuick, error: msg });
		return;
	}

	// Editor review (skipped in quick mode)
	let finalPrompt = generated.prompt;
	if (!isQuick) {
		pi.events.emit("tui_handoff_completed", {
			goal,
			sessionTitle: "",
			paneId: terminalCtx?.paneId ?? null,
		} satisfies TuiHandoffCompletedPayload);

		const editedPrompt = await ctx.ui.editor(
			"Review handoff prompt",
			generated.prompt,
		);
		if (editedPrompt === undefined) {
			ctx.ui.notify("Cancelled", "info");
			emitCommandComplete(pi, {
				goal,
				quickMode: isQuick,
				error: "Cancelled",
			});
			return;
		}
		finalPrompt = editedPrompt;
	}

	// Save artifact
	const handoffDocPath = await saveHandoffArtifact(finalPrompt);
	if (handoffDocPath) {
		ctx.ui.notify(`Handoff document saved: ${handoffDocPath}`, "info");
	} else {
		ctx.ui.notify("Could not save handoff document to temp dir", "warning");
	}

	// Prepare session content
	const { context: contextBlock, nextTask } = splitHandoffPrompt(finalPrompt);
	const sessionTitle = deriveSessionTitle(goal, nextTask || finalPrompt);

	// Create new session
	try {
		const result = await createHandoffSession(pi, ctx, gathered, {
			goal,
			sessionTitle,
			contextBlock,
			liveMessage: nextTask || finalPrompt,
		});

		if (result === "cancelled") {
			ctx.ui.notify("New session cancelled", "info");
			emitCommandComplete(pi, {
				goal,
				quickMode: isQuick,
				error: "Session creation cancelled",
			});
			return;
		}

		emitCommandComplete(pi, {
			goal,
			quickMode: isQuick,
			sessionTitle,
			artifactPath: handoffDocPath || undefined,
		});
	} catch (err) {
		const errorMsg =
			err instanceof Error
				? err.message
				: `Session creation failed: ${String(err)}`;

		printHandoffFallback(
			ctx,
			finalPrompt,
			handoffDocPath || "(unsaved)",
			errorMsg,
		);

		emitCommandComplete(pi, {
			goal,
			quickMode: isQuick,
			artifactPath: handoffDocPath || undefined,
			error: errorMsg,
		});
	}
}
