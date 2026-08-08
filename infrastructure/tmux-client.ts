/**
 * tmux client.
 *
 * Detects whether the process is running inside tmux and provides helpers to
 * capture the current pane and send keystrokes to it. All functions swallow
 * errors so non-tmux or broken-pipe scenarios degrade gracefully.
 */

import { execSync } from "node:child_process";

/** True when the TMUX environment variable is set (process is inside tmux). */
export function isTmuxSession(): boolean {
	return Boolean(process.env.TMUX);
}

/**
 * Capture the tmux pane id of the active pane (e.g. "%5").
 * Returns null when not in tmux or if tmux is unavailable.
 */
export function getCurrentTmuxPaneId(): string | null {
	if (!isTmuxSession()) return null;
	try {
		return execSync('tmux display-message -p "#{pane_id}"', {
			encoding: "utf8",
			stdio: "pipe",
			timeout: 2000,
		}).trim();
	} catch {
		return null;
	}
}

/**
 * Send the Enter key to a specific tmux pane.
 * Returns true on success, false on failure.
 */
export function sendEnterToPane(paneId: string): boolean {
	try {
		execSync(`tmux send-keys -t ${paneId} Enter`, {
			encoding: "utf8",
			stdio: "pipe",
			timeout: 2000,
		});
		return true;
	} catch {
		return false;
	}
}
