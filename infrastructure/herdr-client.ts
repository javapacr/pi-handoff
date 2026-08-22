/**
 * Herdr terminal client.
 *
 * Detects whether the process is running inside a Herdr-managed pane and
 * provides helpers to capture the pane context, persist it to shared memory,
 * and send keystrokes via the `herdr` CLI.
 *
 * All functions swallow errors so non-Herdr or broken-pipe scenarios degrade
 * gracefully.
 */

import { execSync } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HerdrPaneContext } from "../domain/types";

/** True when the HERDR_ENV environment variable is set to "1". */
export function isHerdrSession(): boolean {
	return process.env.HERDR_ENV === "1";
}

/**
 * Read the Herdr pane coordinates from the environment variables that Herdr
 * injects into each managed pane.
 *
 * Returns `null` when not inside Herdr or when any coordinate is missing.
 */
export function getHerdrPaneContext(): HerdrPaneContext | null {
	const workspaceId = process.env.HERDR_WORKSPACE_ID;
	const tabId = process.env.HERDR_TAB_ID;
	const paneId = process.env.HERDR_PANE_ID;

	if (!workspaceId || !tabId || !paneId) return null;

	return {
		workspaceId,
		tabId,
		paneId,
		timestamp: Date.now(),
	};
}

// ── Shared memory ─────────────────────────────────────────────────────────

/**
 * Path to the shared Herdr context file.
 *
 * Stored in the pi agent directory so other pi extensions and tools can
 * discover the Herdr pane coordinates of the last handoff session.
 */
function sharedContextPath(): string {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, ".herdr-handoff-context.json");
}

/**
 * Persist the Herdr pane context to shared memory.
 *
 * Other extensions can read this file to locate the pi session's Herdr pane.
 */
export async function saveHerdrContext(ctx: HerdrPaneContext): Promise<void> {
	try {
		const filePath = sharedContextPath();
		await fs.writeFile(filePath, JSON.stringify(ctx, null, 2), "utf-8");
	} catch {
		// Non-blocking — shared memory is a convenience, not a requirement.
	}
}

/**
 * Load the Herdr pane context from shared memory.
 *
 * Returns `null` when the file doesn't exist or is invalid.
 */
export async function loadHerdrContext(): Promise<HerdrPaneContext | null> {
	try {
		const filePath = sharedContextPath();
		if (!existsSync(filePath)) return null;
		const raw = await fs.readFile(filePath, "utf-8");
		return JSON.parse(raw) as HerdrPaneContext;
	} catch {
		return null;
	}
}

// ── Pane control ──────────────────────────────────────────────────────────

/**
 * Send the Enter key to a specific Herdr pane.
 *
 * Uses `herdr pane send-keys <PANE_ID> Enter`.
 * Returns true on success, false on failure.
 */
export function sendEnterToPane(paneId: string): boolean {
	try {
		execSync(`herdr pane send-keys ${paneId} Enter`, {
			encoding: "utf8",
			stdio: "pipe",
			timeout: 5000,
		});
		return true;
	} catch {
		return false;
	}
}
