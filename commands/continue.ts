/**
 * /continue command.
 *
 * Pushes work into a NEW session. Two forms (no-doc rehaul, design D13):
 *
 * 1. `/continue` (no argument) — handoff launch: recovers the handoff
 *    document from the NEWEST `continue` toolCall in this session's branch
 *    (`arguments.document` — the tool call itself is the stash, so recovery
 *    works after restarts) and creates the new session from it. This is the
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
import { createHandoffSession } from "../application/session-creator";
import {
	emitCommandComplete,
	emitCommandStart,
} from "../infrastructure/event-channels";

/**
 * Newest assistant `continue` toolCall carrying a string
 * `arguments.document` (D10: the tool call is the document stash — it rides
 * the session branch/JSONL). Scanned newest-first; the LAST matching call
 * within the newest matching message wins (repair loops call again).
 */
function recoverHandoffDocument(branch: SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		let document: string | undefined;
		for (const block of content) {
			if (
				typeof block === "object" &&
				block !== null &&
				block.type === "toolCall" &&
				block.name === "continue" &&
				typeof block.arguments.document === "string"
			) {
				document = block.arguments.document;
			}
		}
		if (document !== undefined) return document;
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
				const document = recoverHandoffDocument(ctx.sessionManager.getBranch());
				if (document === undefined) {
					ctx.ui.notify(
						"No handoff document in this session — re-run the handoff",
						"error",
					);
					return;
				}
				emitCommandStart(pi, { goal: null, quickMode: true });
				await launchHandoff(pi, ctx, document);
				return;
			}

			// Any argument is generic text — sent as-is (old docPath habits
			// included; no special-casing, D13).
			await launchGeneric(pi, ctx, raw);
		},
	});
}

/** Handoff mode: live message = provenance line + PA-stripped document + canonical PA. */
async function launchHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	recoveredDocument: string,
): Promise<void> {
	// Idempotent strip: arguments.document is the raw staging input and may
	// still carry a model-authored trailing Phase Adherence even though the
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
	const liveMessage = buildContinuationPrompt(provenanceLine, document)!;
	const sessionTitle = deriveSessionTitle(null, task);

	// Emit the completion BEFORE creating the session — once
	// ctx.newSession() completes, pi invalidates this extension instance
	// and events.emit throws "stale ctx" (live-probed 2026-09-02).
	// Cancel/error paths emit after — safe, no replacement happened there.
	emitCommandComplete(pi, {
		goal: null,
		quickMode: true,
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
			},
		);

		if (result === "cancelled") {
			ctx.ui.notify("New session cancelled", "info");
			emitCommandComplete(pi, {
				goal: null,
				quickMode: true,
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
			error: message,
		});
	}
}
