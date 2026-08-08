/**
 * Handoff execution application service.
 *
 * Orchestrates the full handoff flow from context gathering through prompt
 * review, splitting, labelling, and new-session creation.
 */

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
import { generateHandoffPrompt } from "./prompt-generator";
import { gatherHandoffContext } from "./context-gatherer";
import {
	getCurrentTmuxPaneId,
	isTmuxSession,
} from "../infrastructure/tmux-client";

export interface HandoffCommandArgs {
	rawArgs: string;
}

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

	// Capture the tmux pane id NOW — before any async work (LLM generation,
	// compaction, etc.). If the user switches tmux tabs during generation,
	// the auto-submit listener must still send Enter to THIS pane.
	const tmuxPaneId = isTmuxSession() ? getCurrentTmuxPaneId() : null;

	await maybeSuggestCompaction(ctx);

	const gathered = gatherHandoffContext(ctx);
	if (!gathered.hasConversation) {
		ctx.ui.notify("No conversation to hand off", "error");
		return;
	}

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
		return;
	}

	if (generated.prompt === null) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	if (!generated.prompt.trim()) {
		ctx.ui.notify(
			"Handoff generation returned empty response — check model selection",
			"error",
		);
		return;
	}

	// Editor review (skipped in quick mode)
	let finalPrompt = generated.prompt;
	if (!isQuick) {
		// Emit event so the auto-submit listener can send Enter via tmux to
		// confirm the editor review overlay without manual interaction.
		pi.events.emit("tui_handoff_completed", {
			goal,
			sessionTitle: "",
			tmuxPaneId,
		} satisfies TuiHandoffCompletedPayload);

		const editedPrompt = await ctx.ui.editor(
			"Review handoff prompt",
			generated.prompt,
		);
		if (editedPrompt === undefined) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		finalPrompt = editedPrompt;
	}

	// Split: context block → pre-seeded; next task → live message
	const { context: contextBlock, nextTask } = splitHandoffPrompt(finalPrompt);
	const sessionTitle = deriveSessionTitle(goal, nextTask || finalPrompt);
	const liveMessage = nextTask || finalPrompt;

	// Label the handoff point in the OLD session
	if (gathered.leafId) {
		try {
			pi.setLabel(gathered.leafId, `handoff → ${sessionTitle}`);
		} catch {
			// not critical
		}
	}

	// Create new session
	const currentSessionFile = gathered.currentSessionFile;
	const newSessionResult = await ctx.newSession({
		parentSession: currentSessionFile,

		setup: async (sm) => {
			// 1. Set display name (shown in /resume picker)
			sm.appendSessionInfo(sessionTitle);

			// 2. Pre-seed context as a user message so the agent treats it as
			//    background history rather than a new prompt to respond to.
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

			// 3. Store handoff-origin marker for session_start notification
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

	if (newSessionResult.cancelled) {
		ctx.ui.notify("New session cancelled", "info");
	}
}
