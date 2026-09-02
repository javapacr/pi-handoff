/**
 * /continue command — in-session mode only.
 *
 * Takes the generated handoff document and pushes it into the next session.
 * The `continue` tool pre-fills `/continue <docPath>` after the doc is
 * written; the command re-validates the document and creates the new session
 * through the SAME path as the detached flow (shared `createHandoffSession`):
 * leaf label, pre-seeded handoff context, live first message = the Next Task.
 *
 * The argument is optional: `/continue` with no argument uses the NEWEST
 * `handoff-*.md` in the handoff data dir — manual recovery when auto-submit
 * missed.
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
	splitHandoffPrompt,
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
			"Continue the current work in a new session from a handoff document. Usage: /continue [docPath]",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("continue requires interactive mode", "error");
				return;
			}

			const rawPath = args.trim().replace(/^"(.*)"$/, "$1");
			let docPath: string;
			if (!rawPath) {
				const latest = newestHandoffDocPath();
				if (!latest) {
					ctx.ui.notify(
						`No handoff documents in ${join(resolvePiAgentDir(), "data", "pi-handoff")} — run /handoff first`,
						"error",
					);
					return;
				}
				docPath = latest;
			} else {
				docPath = isAbsolute(rawPath)
					? rawPath
					: join(ctx.cwd, rawPath);
			}

			emitCommandStart(pi, { goal: null, quickMode: true });

			let doc: string;
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

			const { context: contextBlock } = splitHandoffPrompt(doc);
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
						contextBlock,
						liveMessage,
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
				const message =
					err instanceof Error ? err.message : String(err);
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
		},
	});
}
