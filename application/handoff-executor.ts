/**
 * Handoff execution application service.
 *
 * Orchestrates the detached `/handoff` flow: context gathering → memory
 * pre-flight → one-off LLM generation → in-memory validation → DIRECT launch
 * of the new session (no-doc rehaul, D12). No document file, no editor
 * review, no editor staging — the executor itself calls createHandoffSession
 * (command context: it holds newSession) with the same live-message shape
 * the `/continue` path composes: provenance line + PA-stripped document +
 * canonical Phase Adherence.
 *
 * Every post-generation failure mode (invalid `## Next Task`, session
 * creation throwing, session creation cancelled) routes through the
 * clipboard + stderr rescue — a flash-model generation is never silently
 * destroyed. Lifecycle events are emitted on the event bus.
 */

import { execSync } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { HandoffPromptResult, HandoffSettings } from "../domain/types";
import {
	buildContinuationPrompt,
	deriveSessionTitle,
	findNextTaskContent,
	stripTrailingPhaseAdherence,
} from "../domain/handoff-prompt";
import { buildProvenanceLine } from "../domain/provenance";
import type { GatheredContext } from "./context-gatherer";
import { generateHandoffPrompt } from "./prompt-generator";
import { gatherHandoffContext } from "./context-gatherer";
import { maybeRunDiaryReminder } from "./diary-reminder";
import { hasHandoffableConversation } from "../infrastructure/session-adapter";
import { createHandoffSession } from "./session-creator";
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
 * Rescue a generated handoff that could not be launched: copy the text to
 * the system clipboard (best-effort macOS pbcopy) and print it to stderr so
 * the user can paste it into a new session manually. Nothing was written to
 * disk (no-doc rehaul, D12) — there is no file path to name; the generated
 * handoff text itself is the rescue artifact.
 */
function printHandoffFallback(
	ctx: ExtensionCommandContext,
	prompt: string,
	reason: string,
): void {
	// Rescue FIRST, notify LAST: if this runs on a stale ctx (post-replacement
	// throw in runtimes where newSession rejects normally), a throwing notify
	// must not eat the clipboard/stderr copy — the text exists nowhere else.
	copyToClipboard(prompt);

	process.stderr.write(
		`\n${"=".repeat(60)}\n` +
			`HANDOFF TEXT (copy below into a new session)\n` +
			`${"=".repeat(60)}\n` +
			`${prompt}\n` +
			`${"=".repeat(60)}\n\n`,
	);

	ctx.ui.notify(
		`Handoff could not launch (${reason}) — the generated text was copied ` +
			`to the clipboard and printed to stderr.`,
		"warning",
	);
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

	const goal = args.rawArgs || null;

	emitCommandStart(pi, { goal, quickMode: false });

	// Cheap gate: only proceed when the session has a handoffable conversation
	// (≥1 user/assistant message) — no full context build here. The full gather
	// happens once, below, after the memory pre-flight.
	if (!hasHandoffableConversation(ctx)) {
		ctx.ui.notify("No conversation to hand off", "error");
		emitCommandComplete(pi, {
			goal,
			quickMode: false,
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
							documentFiles: gathered.context.documentFiles,
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
			quickMode: false,
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
		emitCommandComplete(pi, { goal, quickMode: false, error: msg });
		return;
	}

	if (!gathered) {
		// Unreachable in practice: every non-cancelled, non-error result passed
		// through the gather step. Kept so downstream code never sees undefined
		// context.
		ctx.ui.notify("Handoff failed: context was not gathered", "error");
		emitCommandComplete(pi, {
			goal,
			quickMode: false,
			error: "Context was not gathered",
		});
		return;
	}

	// Normalize + validate in memory (D12): strip a model-authored trailing
	// Phase Adherence, require a non-empty `## Next Task`. Nothing is saved
	// and no editor is shown — the document itself becomes the new session's
	// live first message.
	const document = stripTrailingPhaseAdherence(generated.prompt);
	const task = findNextTaskContent(document);
	if (task === null) {
		// Rescue (a): the flash-model generation is never silently destroyed —
		// raw generated text goes to clipboard + stderr.
		printHandoffFallback(
			ctx,
			generated.prompt,
			'the generated handoff has no non-empty "## Next Task" section',
		);
		emitCommandComplete(pi, {
			goal,
			quickMode: false,
			error: 'Generated handoff has no "## Next Task" section',
		});
		return;
	}

	const sessionTitle = deriveSessionTitle(goal, task);

	// Same live-message shape as the `/continue` launch path (D11): the
	// provenance line prepended, the PA-stripped document, the canonical
	// Phase Adherence appended — as ONE visible first message.
	const provenanceLine = buildProvenanceLine(
		ctx.sessionManager.getSessionFile(),
	);
	// Non-null: `task` (checked above) is derived from the same document this
	// call re-validates internally.
	const liveMessage = buildContinuationPrompt(provenanceLine, document)!;

	const stats: string[] = [];
	if (generated.modelId) stats.push(`generated with ${generated.modelId}`);
	if (generated.durationMs != null) {
		stats.push(`in ${(generated.durationMs / 1000).toFixed(1)}s`);
	}
	const statLine = stats.length > 0 ? ` · ${stats.join(" ")}` : "";
	ctx.ui.notify(`Handoff launching: ${sessionTitle}${statLine}`, "info");

	// Emit the completion BEFORE creating the session — once
	// ctx.newSession() completes, pi invalidates this extension instance and
	// events.emit/ctx calls throw "stale ctx" (live-probed 2026-09-02).
	// Cancel/error paths below emit after — safe, no replacement happened
	// there.
	emitCommandComplete(pi, { goal, quickMode: false, sessionTitle });

	try {
		const result = await createHandoffSession(
			pi,
			ctx,
			{
				currentSessionFile: ctx.sessionManager.getSessionFile(),
				leafId: ctx.sessionManager.getLeafId(),
			},
			{
				goal,
				sessionTitle,
				liveMessage,
				// Same durable audit-trail payload as the `/continue` launch:
				// provenance line + stripped body in the hidden entry's details.
				document: `${provenanceLine}\n\n${document}`,
			},
		);

		if (result === "cancelled") {
			// Rescue (c): no session was created — the composed launch message
			// (provenance + document + canonical PA) goes to clipboard + stderr.
			printHandoffFallback(ctx, liveMessage, "new session was cancelled");
			emitCommandComplete(pi, {
				goal,
				quickMode: false,
				error: "Session creation cancelled",
			});
		}
	} catch (err) {
		// Rescue (b): session creation threw — same rescue surface.
		const message = err instanceof Error ? err.message : String(err);
		printHandoffFallback(ctx, liveMessage, message);
		emitCommandComplete(pi, { goal, quickMode: false, error: message });
	}
}
