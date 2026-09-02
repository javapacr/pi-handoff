/**
 * /handoff-launch command — in-session mode only.
 *
 * The mechanical launcher that `handoff_launch` pre-fills. Reads the written
 * handoff document, re-validates its `## Next Task` section, and creates the
 * new session through the SAME path as the detached flow (shared
 * `createHandoffSession`): leaf label, pre-seeded handoff context, live first
 * message = the Next Task payload.
 *
 * Can also be run manually for recovery, e.g. when auto-submit missed:
 * `/handoff-launch /path/to/handoff-<ts>.md`.
 */

import { promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	deriveSessionTitle,
	findNextTaskSection,
	splitHandoffPrompt,
} from "../domain/handoff-prompt";
import { createHandoffSession } from "../application/session-creator";
import {
	emitCommandComplete,
	emitCommandStart,
} from "../infrastructure/event-channels";

export function registerHandoffLaunchCommand(pi: ExtensionAPI): void {
	pi.registerCommand("handoff-launch", {
		description:
			"Launch the new session from a written handoff document. Usage: /handoff-launch <docPath>",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("handoff-launch requires interactive mode", "error");
				return;
			}

			const rawPath = args.trim().replace(/^"(.*)"$/, "$1");
			if (!rawPath) {
				ctx.ui.notify(
					"Usage: /handoff-launch <handoff-doc-path>",
					"error",
				);
				return;
			}
			const docPath = isAbsolute(rawPath)
				? rawPath
				: join(ctx.cwd, rawPath);

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

			const nextTask = findNextTaskSection(doc);
			if (nextTask === null) {
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
			const sessionTitle = deriveSessionTitle(null, nextTask);

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
						liveMessage: nextTask,
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
					`Handoff launch failed: ${message}. The document is preserved at ${docPath}.`,
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
