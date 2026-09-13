/**
 * Configuration repository for handoff settings.
 *
 * Reads the optional `handoff` block from `PI_CODING_AGENT_DIR/settings.json`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HandoffSettings } from "../domain/types";

function expandHomeDirectory(
	configuredDir: string,
	homeDirectory: string,
): string {
	if (configuredDir === "~") return homeDirectory;
	if (configuredDir.startsWith("~/") || configuredDir.startsWith("~\\")) {
		return join(homeDirectory, configuredDir.slice(2));
	}
	return configuredDir;
}

/**
 * Resolve the pi agent directory (PI_CODING_AGENT_DIR env → ~/.pi/agent),
 * expanding a leading ~. Exported for the handoff data dir + the origin
 * profile stamp on the handoff-origin entry.
 */
export function resolvePiAgentDir(): string {
	const configuredDir = process.env.PI_CODING_AGENT_DIR;
	if (!configuredDir) {
		return join(homedir(), ".pi", "agent");
	}
	return expandHomeDirectory(configuredDir, homedir());
}

/** Data dir for handoff documents, under the pi agent dir. Kept for the
 * document-files denylist (legacy on-disk docs must stay denied). */
export function handoffDataDir(): string {
	return join(resolvePiAgentDir(), "data", "pi-handoff");
}

export function loadHandoffSettings(): HandoffSettings | null {
	try {
		const settingsPath = join(resolvePiAgentDir(), "settings.json");
		const raw = readFileSync(settingsPath, "utf8");
		const parsed = JSON.parse(raw) as { handoff?: HandoffSettings };
		return parsed.handoff ?? null;
	} catch {
		return null;
	}
}
