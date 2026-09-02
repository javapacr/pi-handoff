/**
 * /continue command — in-session mode only.
 *
 * Pushes work into a NEW session. Three forms:
 *
 * 1. `/continue <docPath>` — handoff mode (what the `continue` tool
 *    pre-fills): docPath is a handoff document. Seeds a compact reference
 *    (path + read-first instruction — the doc is NOT pre-loaded, it can be
 *    large) and sends the document's Next Task + canonical Phase Adherence
 *    as the live message.
 * 2. `/continue <text>` — generic: the text is sent AS-IS as the new
 *    session's live message. Nothing pre-loaded. For any use case where you
 *    want to continue in a fresh session with a specific instruction.
 * 3. `/continue` (no argument) — uses the NEWEST `handoff-*.md` in the handoff
 *    data dir (manual recovery when auto-submit missed).
 *
 * Disambiguation between 1 and 2 is existence-based: if the argument resolves
 * to an existing file, it is treated as a handoff document; otherwise it is
 * sent as literal text.
 *
 * Session creation goes through the shared `createHandoffSession` (same path
 * as the detached flow): leaf label, seeded reference, live first message.
 */

import { promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	buildContinuationPrompt,
	deriveSessionTitle,
} from "../domain/handoff-prompt";
import { createHandoffSession } from "../application/session-creator";
import {
	emitCommandComplete,
	emitCommandStart,
} from "../infrastructure/event-channels";
import {
	newestHandoffDocPath,
	resolvePiAgentDir,
} from "../infrastructure/config-repository";

export function registerContinueCommand(pi: ExtensionAPI): void {
	pi.registerCommand("continue", {
		description:
			"Continue in a new session. /continue <docPath|text> — an existing file path seeds it as read-first handoff context; any other text is sent to the new session as-is. No argument uses the newest handoff doc.",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("continue requires interactive mode", "error");
				return;
			}

			const raw = args.trim().replace(/^"(.*)"$/, "$1");

			// No argument → newest handoff document.
			if (!raw) {
				const latest = newestHandoffDocPath();
				if (!latest) {
					ctx.ui.notify(
						`No handoff documents in ${join(resolvePiAgentDir(), "data", "pi-handoff")} — run /handoff first, or pass text: /continue <what to do next>`,
						"error",
					);
					return;
				}
				emitCommandStart(pi, { goal: null, quickMode: true });
				await launchFromDoc(pi, ctx, latest);
				return;
			}

			// Existing file → handoff document mode.
			const candidate = isAbsolute(raw) ? raw : join(ctx.cwd, raw);
			let doc: string | undefined;
			try {
				doc = await fs.readFile(candidate, "utf8");
			} catch {
				doc = undefined;
			}

			emitCommandStart(pi, { goal: null, quickMode: true });

			if (doc !== undefined) {
				await launchFromDoc(pi, ctx, candidate, doc);
				return;
			}

			// Generic mode: send the text as-is.
			await launchGeneric(pi, ctx, raw);
		},
	});
}

/** Handoff mode: seed the document reference, live message = Next Task + PA. */
async function launchFromDoc(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	docPath: string,
	doc?: string,
): Promise<void> {
	if (doc === undefined) {
		try {
			doc = await fs.readFile(docPath, "utf8");
		} catch {
			ctx.ui.notify(`Handoff document not found: ${docPath}`, "error");
			emitCommandComplete(pi, {
				goal: null,
				quickMode: true,
				error: `Handoff document not found: ${docPath}`,
			});
			return;
		}
	}

	const liveMessage = buildContinuationPrompt(doc);
	if (liveMessage === null) {
		ctx.ui.notify(
			`Handoff document has no non-empty "## Next Task" section — fix ${docPath} or run /handoff again`,
			"error",
		);
		emitCommandComplete(pi, {
			goal: null,
			quickMode: true,
			error: `Invalid handoff document: ${docPath}`,
		});
		return;
	}

	const sessionTitle = deriveSessionTitle(null, liveMessage);

	// Emit the completion BEFORE creating the session — once
	// ctx.newSession() completes, pi invalidates this extension instance
	// and events.emit throws "stale ctx" (live-probed 2026-09-02).
	// Cancel/error paths emit after — safe, no replacement happened there.
	emitCommandComplete(pi, {
		goal: null,
		quickMode: true,
		sessionTitle,
		artifactPath: docPath,
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
				artifactPath: docPath,
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
		ctx.ui.notify(
			`Continue failed: ${message}. The document is preserved at ${docPath}.`,
			"error",
		);
		emitCommandComplete(pi, {
			goal: null,
			quickMode: true,
			artifactPath: docPath,
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
