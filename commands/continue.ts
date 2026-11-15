/**
 * /continue command.
 *
 * Pushes work into a NEW session. Two forms (no-doc rehaul, design D13):
 *
 * 1. `/continue` (no argument) — handoff launch: recovers the handoff
 *    document from the NEWEST `continue` toolCall in this session's branch
 *    (`arguments.document` and optional `arguments.nextState` — the tool call
 *    itself is the stash, so recovery works after restarts) and creates the
 *    new session from it, keeping or routing the session state. This is the
 *    path the `continue` tool stages, and the manual recovery when
 *    auto-submit missed.
 * 2. `/continue <text>` — generic: the text is sent AS-IS as the new
 *    session's live message. Nothing pre-loaded. Old docPath arguments are
 *    NOT special-cased — a typed path is just text.
 *
 * Session creation goes through the shared `createHandoffSession` (leaf
 * label, hidden handoff-origin entry, live first message).
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	buildContinuationPrompt,
	deriveSessionTitle,
	findNextTaskContent,
	stripTrailingPhaseAdherence,
} from "../domain/handoff-prompt";
import { buildProvenanceLine } from "../domain/provenance";
import { planCarry } from "../domain/session-state-carry";
import { createHandoffSession } from "../application/session-creator";
import {
	emitCommandComplete,
	emitCommandStart,
} from "../infrastructure/event-channels";

/**
 * Newest assistant `continue` toolCall carrying a string
 * `arguments.document` (D10: the tool call is the document stash — it rides
 * the session branch/JSONL). Scanned newest-first; the LAST matching call
 * within the newest matching message wins (repair loops call again). The
 * `nextState` comes from that same call, `null` when absent or blank.
 */
function recoverHandoff(
	branch: SessionEntry[],
): { document: string; nextState: string | null } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		let recovered: { document: string; nextState: string | null } | undefined;
		for (const block of content) {
			if (
				typeof block === "object" &&
				block !== null &&
				block.type === "toolCall" &&
				block.name === "continue" &&
				typeof block.arguments.document === "string"
			) {
				const nextState = block.arguments.nextState;
				recovered = {
					document: block.arguments.document,
					nextState:
						typeof nextState === "string" && nextState.trim().length > 0
							? nextState
							: null,
				};
			}
		}
		if (recovered !== undefined) return recovered;
	}
	return undefined;
}

export function registerContinueCommand(pi: ExtensionAPI): void {
	pi.registerCommand("continue", {
		description:
			"Continue in a new session. No argument: launch the handoff the continue tool staged (recovers its document from this session). Any text: sent to the new session as-is.",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("continue requires interactive mode", "error");
				return;
			}

			const raw = args.trim().replace(/^"(.*)"$/, "$1");

			// Bare → recover the handoff document staged by the `continue` tool.
			if (!raw) {
				const recovered = recoverHandoff(ctx.sessionManager.getBranch());
				if (recovered === undefined) {
					ctx.ui.notify(
						"No handoff document in this session — re-run the handoff",
						"error",
					);
					return;
				}
				emitCommandStart(pi, {
					goal: null,
					quickMode: true,
					trigger: "continue",
				});
				await launchHandoff(pi, ctx, recovered.document, recovered.nextState);
				return;
			}

			// Any argument is generic text — sent as-is (old docPath habits
			// included; no special-casing, D13).
			await launchGeneric(pi, ctx, raw);
		},
	});
}

/** Handoff mode: live message = provenance line + state line (when any) + document. */
async function launchHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	recoveredDocument: string,
	nextState: string | null,
): Promise<void> {
	// Idempotent strip: arguments.document is the raw staging input and may
	// still carry a legacy trailing Phase Adherence even though the
	// tool normalized its own copy.
	const document = stripTrailingPhaseAdherence(recoveredDocument);

	const task = findNextTaskContent(document);
	if (task === null) {
		ctx.ui.notify(
			`Recovered handoff document has no non-empty "## Next Task" section — re-run the handoff`,
			"error",
		);
		emitCommandComplete(pi, {
			goal: null,
			quickMode: true,
			trigger: "continue",
			error: "Recovered handoff document is invalid",
		});
		return;
	}

	// Provenance is recomputed at LAUNCH, not reused from the tool's staging
	// record: the linkage must reflect the session that actually launches the
	// handoff (this one) and the launch time.
	const provenanceLine = buildProvenanceLine(
		ctx.sessionManager.getSessionFile(),
	);
	// Non-null: `task` (checked above) is the same Next Task section this call
	// re-derives from the same document, so the null arm is unreachable here.
	// The plan reads the branch at launch time, not at tool-call time.
	const carryPlan = planCarry(ctx.sessionManager.getBranch(), {
		via: "continue",
		nextState,
	});
	const liveMessage = buildContinuationPrompt(
		provenanceLine,
		document,
		carryPlan.stampLine,
	)!;
	const sessionTitle = deriveSessionTitle(null, task);

	// Emit the completion BEFORE creating the session — once
	// ctx.newSession() completes, pi invalidates this extension instance
	// and events.emit throws "stale ctx" (live-probed 2026-09-02).
	// Cancel/error paths emit after — safe, no replacement happened there.
	emitCommandComplete(pi, {
		goal: null,
		quickMode: true,
		trigger: "continue",
		sessionTitle,
	});

	try {
		const result = await createHandoffSession(
			pi,
			ctx,
			{
				currentSessionFile: ctx.sessionManager.getSessionFile(),
				leafId: ctx.sessionManager.getLeafId(),
			},
			{
				goal: null,
				sessionTitle,
				liveMessage,
				document: `${provenanceLine}\n\n${document}`,
				sessionStateSeed: carryPlan.seed,
			},
		);

		if (result === "cancelled") {
			ctx.ui.notify("New session cancelled", "info");
			emitCommandComplete(pi, {
				goal: null,
				quickMode: true,
				trigger: "continue",
				error: "Session creation cancelled",
			});
			return;
		}

		// Success: completion was emitted pre-replacement; the "Handoff
		// started" notify comes from withSession's fresh replacement ctx.
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`Continue failed: ${message}`, "error");
		emitCommandComplete(pi, {
			goal: null,
			quickMode: true,
			trigger: "continue",
			error: message,
		});
	}
}

/** Generic mode: the text is sent to the new session as-is. */
async function launchGeneric(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	text: string,
): Promise<void> {
	const sessionTitle = deriveSessionTitle(null, text);

	emitCommandComplete(pi, {
		goal: null,
		quickMode: true,
		trigger: "continue",
		sessionTitle,
	});

	try {
		const result = await createHandoffSession(
			pi,
			ctx,
			{
				currentSessionFile: ctx.sessionManager.getSessionFile(),
				leafId: ctx.sessionManager.getLeafId(),
			},
			{
				goal: null,
				sessionTitle,
				liveMessage: text,
			},
		);

		if (result === "cancelled") {
			ctx.ui.notify("New session cancelled", "info");
			emitCommandComplete(pi, {
				goal: null,
				quickMode: true,
				trigger: "continue",
				error: "Session creation cancelled",
			});
			return;
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`Continue failed: ${message}`, "error");
		emitCommandComplete(pi, {
			goal: null,
			quickMode: true,
			trigger: "continue",
			error: message,
		});
	}
}
