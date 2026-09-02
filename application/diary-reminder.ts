/**
 * Diary reminder application service.
 *
 * When /handoff runs, injects one suggestion message into the CURRENT
 * session's agent loop, nudging the agent to persist durable session
 * learnings to MemPalace (via `mempalace_diary_write`) before the handoff
 * transfers context to a new session. The agent decides — it skips on its
 * own when the diary is already written for this session or nothing
 * durable is worth recording.
 *
 * Ordering: runs inside executeHandoff after the initial has-conversation
 * gate and before prompt generation, so the diary decision happens while the
 * current session (and its memory tools) are still live. The executor
 * re-gathers context afterwards, so the handoff snapshot includes the diary
 * turn and its leaf id marks the true handoff point.
 *
 * Best-effort by design: any failure is surfaced as a UI notify and the
 * handoff proceeds regardless — this feature must never break the handoff.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { HandoffSettings } from "../domain/types";

/** First-class MemPalace diary tool — the nudge only fires when it is active. */
const DIARY_TOOL_NAME = "mempalace_diary_write";

/** Hard cap on the diary turn so a hung model cannot stall the handoff. */
const DIARY_REMINDER_TIMEOUT_MS = 120_000;

const DIARY_REMINDER_NUDGE =
	"[handoff preflight] A session handoff is starting. Before context transfers, consider whether this session produced anything worth persisting to long-term memory: write a MemPalace diary entry (mempalace_diary_write, AAAK format) capturing durable observations, decisions, gotchas, or outcomes — things not already recorded in committed docs, plans, or artifacts. Skip if you already wrote a diary entry for this session or there is nothing durable worth recording. Do not start new work; keep any reply to one short line.";

/**
 * Maybe nudge the agent to write a MemPalace diary entry before the handoff.
 *
 * Skips silently when disabled (`handoff.diaryReminder: false` in settings)
 * or when `mempalace_diary_write` is not among the active tools, so sessions
 * without the memory system pay zero noise and zero extra turns. Otherwise
 * sends the suggestion as a user message (queued via followUp when the agent
 * is mid-turn) and waits — capped at 120 seconds — for the agent's turn to
 * finish before the handoff continues.
 */
export async function maybeRunDiaryReminder(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	settings: HandoffSettings | null,
	onStatus?: (status: string) => void,
): Promise<void> {
	try {
		// Opt-out switch (absent = enabled).
		if (settings?.diaryReminder === false) return;

		// No memory tool in this session → no nudge, no extra turn. Check both
		// lists: first-class MCP direct tools may surface in only one of them.
		const hasDiaryTool =
			pi.getActiveTools().includes(DIARY_TOOL_NAME) ||
			pi
				.getAllTools()
				.some((tool) => tool.name === DIARY_TOOL_NAME);
		if (!hasDiaryTool) return;

		// followUp queues behind a running turn; when idle it triggers one.
		pi.sendUserMessage(DIARY_REMINDER_NUDGE, { deliverAs: "followUp" });
		onStatus?.("Memory pre-flight: agent persisting session learnings…");

		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(() => {
				timedOut = true;
				resolve();
			}, DIARY_REMINDER_TIMEOUT_MS);
		});

		try {
			await Promise.race([ctx.waitForIdle(), timeout]);
		} finally {
			clearTimeout(timer);
		}

		if (timedOut) {
			onStatus?.("Memory pre-flight still running — continuing");
			ctx.ui.notify(
				"Diary reminder turn still running — continuing handoff",
				"info",
			);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`Diary reminder skipped: ${message}`, "warning");
	}
}
