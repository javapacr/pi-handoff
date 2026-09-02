/**
 * Configuration repository for handoff settings.
 *
 * Reads the optional `handoff` block from `PI_CODING_AGENT_DIR/settings.json`.
 */

import { readFileSync, readdirSync } from "node:fs";
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
 * expanding a leading ~. Exported for the in-session doc path
 * ($AGENT_DIR/data/pi-handoff/…) and future cost logging.
 */
export function resolvePiAgentDir(): string {
	const configuredDir = process.env.PI_CODING_AGENT_DIR;
	if (!configuredDir) {
		return join(homedir(), ".pi", "agent");
	}
	return expandHomeDirectory(configuredDir, homedir());
}

/** Data dir for handoff documents, under the pi agent dir. */
export function handoffDataDir(): string {
	return join(resolvePiAgentDir(), "data", "pi-handoff");
}

/** Timestamped doc path, same format as the detached artifact name. */
export function newHandoffDocPath(): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(handoffDataDir(), `handoff-${timestamp}.md`);
}

/**
 * Newest handoff document in the data dir, or null when none exist.
 * Backs argument-less `/continue` (manual recovery).
 */
export function newestHandoffDocPath(): string | null {
	try {
		const docs = readdirSync(handoffDataDir())
			.filter((f) => f.startsWith("handoff-") && f.endsWith(".md"))
			.sort();
		const latest = docs.at(-1);
		return latest ? join(handoffDataDir(), latest) : null;
	} catch {
		return null;
	}
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
