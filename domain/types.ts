/**
 * Handoff domain types.
 *
 * Pure data shapes used across the extension. No infrastructure imports.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";

export interface Todo {
	id: number;
	text: string;
	done: boolean;
}

export interface TodoDetails {
	todos: Todo[];
	nextId: number;
}

export interface GitContext {
	branch: string;
	status: string;
	diffStat: string;
	recentCommits: string;
}

export interface HandoffOriginData {
	parentSession: string | undefined;
	goal: string | null;
	timestamp: number;
}

export interface HandoffSettings {
	/**
	 * Provider id for the handoff generation model (e.g. "deepseek").
	 *
	 * When set, `model` should be the bare model id without a provider prefix.
	 */
	provider?: string;
	/**
	 * Model id for handoff generation.
	 *
	 * May be bare (when `provider` is set) or a canonical `provider/model`
	 * reference (legacy).
	 */
	model?: string;
	effort?: ThinkingLevel;
}

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface HandoffContext {
	conversationText: string;
	todos: string | null;
	git: GitContext | null;
	skills: string | null;
	cwd: string;
	contextUsage: ContextUsage | undefined;
}

export interface HandoffPromptResult {
	prompt: string | null;
	error?: string;
}

/**
 * Payload emitted on the `tui_filled_handoff` event bus channel when the
 * `request_handoff` tool pre-fills the editor with `/handoff <goal>`.
 */
export interface TuiFilledHandoffPayload {
	/** The goal string passed to `request_handoff`. */
	goal: string;
	/** The full command pre-filled in the editor (e.g. `/handoff fix the bug`). */
	command: string;
}

/**
 * Payload emitted on the `tui_handoff_completed` event bus channel when the
 * `/handoff` command finishes creating the new session.
 */
export interface TuiHandoffCompletedPayload {
	/** The goal for the new session (null when inferred). */
	goal: string | null;
	/** The display title assigned to the new session. */
	sessionTitle: string;
	/**
	 * The tmux pane id captured at the START of the handoff flow (before LLM
	 * generation). When provided, the auto-submit listener uses this instead
	 * of re-capturing the active pane — which may have changed if the user
	 * switched tmux tabs during generation.
	 */
	tmuxPaneId?: string | null;
}
