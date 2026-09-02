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
	HandoffPromptResult,
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
import { createHandoffSession } from "./session-creator";
import { maybeRunDiaryReminder } from "./diary-reminder";
import {
	captureTerminalContext,
	type TerminalContext,
} from "../infrastructure/terminal-strategy";
import { hasHandoffableConversation } from "../infrastructure/session-adapter";
import {
	emitCommandStart,
	emitCommandComplete,
} from "../infrastructure/event-channels";
import { HandoffLoader } from "../ui/handoff-loader";

export interface HandoffCommandArgs {
	rawArgs: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Compact k-notation for progress lines (1234 → "1.2k"). */
function formatK(n: number): string {
	return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
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

	// Cheap gate: only proceed when the session has a handoffable conversation
	// (≥1 user/assistant message) — no full context build here. The full gather
	// happens once, below, after the memory pre-flight.
	if (!hasHandoffableConversation(ctx)) {
		ctx.ui.notify("No conversation to hand off", "error");
		emitCommandComplete(pi, {
			goal,
			quickMode: isQuick,
			error: "No conversation to hand off",
		});
		return;
	}

	// ONE continuous loader spanning memory pre-flight → snapshot → generation,
	// so every phase (including the diary wait) is visible with live progress.
	let gathered: GatheredContext | undefined;

	const generated = await ctx.ui.custom<HandoffPromptResult>(
		(tui, theme, _kb, done) => {
			// Current phase line; `timed` phases get an elapsed "(Xs)" suffix.
			let phaseLine = "Gathering context…";
			let phaseStartedAt = Date.now();
			let phaseTimed = false;
			let settled = false;
			let ticker: ReturnType<typeof setInterval> | undefined;

			const render = () => {
				if (settled) return;
				if (phaseTimed) {
					const secs = Math.floor((Date.now() - phaseStartedAt) / 1000);
					loader.setLine(`${phaseLine} (${secs}s)`);
				} else {
					loader.setLine(phaseLine);
				}
			};

			const setPhase = (line: string, timed = false) => {
				phaseLine = line;
				phaseStartedAt = Date.now();
				phaseTimed = timed;
				render();
			};

			// Single settle point: clears the ticker on every exit path
			// (success, abort, error, cancel) exactly once.
			const finish = (result: HandoffPromptResult) => {
				if (settled) return;
				settled = true;
				if (ticker !== undefined) clearInterval(ticker);
				done(result);
			};

			const loader = new HandoffLoader(tui, theme, "Gathering context…", () =>
				finish({ prompt: null }),
			);

			ticker = setInterval(render, 1000);

			const run = async (): Promise<HandoffPromptResult> => {
				try {
					// Nudge the agent to persist durable learnings to MemPalace before
					// the handoff prompt is generated — while this session and its
					// memory tools are still live. Best-effort: never blocks or breaks
					// the handoff.
					await maybeRunDiaryReminder(pi, ctx, settings, (status) =>
						setPhase(status, true),
					);
					phaseTimed = false;

					if (loader.signal.aborted) return { prompt: null };

					// Re-gather so the handoff snapshot includes the diary turn and the
					// leaf label lands on the true handoff point (the nudge appended
					// entries).
					gathered = gatherHandoffContext(ctx);
					const messageCount = gathered.context.messageCount;
					const chars = formatK(gathered.context.conversationText.length);
					setPhase(
						messageCount == null
							? `Snapshotting context (${chars} chars)…`
							: `Snapshotting context (${messageCount} messages, ${chars} chars)…`,
					);

					if (loader.signal.aborted) return { prompt: null };

					return await generateHandoffPrompt(
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
						(status) => setPhase(status),
						loader.signal,
					);
				} finally {
					if (ticker !== undefined) clearInterval(ticker);
				}
			};

			run()
				.then(finish)
				.catch((err) => {
					console.error("Handoff flow failed:", err);
					finish({
						prompt: null,
						error:
							err instanceof Error
								? err.message
								: `Handoff flow failed: ${String(err)}`,
					});
				});

			return loader;
		},
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

	if (!gathered) {
		// Unreachable in practice: every non-cancelled, non-error result passed
		// through the gather step. Kept so downstream code never sees undefined
		// context.
		ctx.ui.notify("Handoff failed: context was not gathered", "error");
		emitCommandComplete(pi, {
			goal,
			quickMode: isQuick,
			error: "Context was not gathered",
		});
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
		const stats: string[] = [];
		if (generated.modelId) stats.push(`generated with ${generated.modelId}`);
		if (generated.durationMs != null) {
			stats.push(`in ${(generated.durationMs / 1000).toFixed(1)}s`);
		}
		const statLine = stats.length > 0 ? ` · ${stats.join(" ")}` : "";
		ctx.ui.notify(
			`Handoff document saved: ${handoffDocPath}${statLine}`,
			"info",
		);
	} else {
		ctx.ui.notify("Could not save handoff document to temp dir", "warning");
	}

	// Prepare session content
	const { context: contextBlock, nextTask } = splitHandoffPrompt(finalPrompt);
	const sessionTitle = deriveSessionTitle(goal, nextTask || finalPrompt);

	// Emit the success-path completion BEFORE creating the session: once
	// ctx.newSession() completes, pi invalidates this extension instance and
	// any pi.* call (including events.emit) throws "stale ctx" (live-probed
	// 2026-09-02: the post-replacement emit was silently lost). Cancel and
	// error paths below still emit after — safe, because no replacement
	// happened in those cases, so pi is still valid.
	emitCommandComplete(pi, {
		goal,
		quickMode: isQuick,
		sessionTitle,
		artifactPath: handoffDocPath || undefined,
	});

	// Create new session
	try {
		const result = await createHandoffSession(
			pi,
			ctx,
			{
				currentSessionFile: gathered.currentSessionFile,
				leafId: gathered.leafId,
			},
			{
				goal,
				sessionTitle,
				liveMessage: nextTask || finalPrompt,
				artifactPath: handoffDocPath || undefined,
			},
		);

		if (result === "cancelled") {
			ctx.ui.notify("New session cancelled", "info");
			emitCommandComplete(pi, {
				goal,
				quickMode: isQuick,
				error: "Session creation cancelled",
			});
			return;
		}

		// Success: nothing more to emit here — completion was emitted
		// pre-replacement above, and the "Handoff started" notify comes from
		// withSession's fresh replacement ctx.
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
