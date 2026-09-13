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

/**
 * Built-in pi todo tool details shape (legacy).
 */
export interface TodoDetails {
	todos: Todo[];
	nextId: number;
}

/**
 * rpiv-todo (@juicesharp/rpiv-todo) task details shape.
 *
 * The tool name is still "todo" but the details use `tasks` instead of
 * `todos`, and each task has `subject` + `status` instead of `text` + `done`.
 */
export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

export interface TaskDetails {
	action: string;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
	error?: string;
}

/**
 * Git state for a single repository.
 */
export interface GitRepoState {
	/** Absolute path to the repository root (git toplevel). */
	workingDirectory: string;
	/** Display path — "." for the workspace itself, or a relative sub-path for sub-repos in an anchor repo. */
	path: string;
	branch: string;
	status: string;
	diffStat: string;
	recentCommits: string;
}

/**
 * Git context gathered from one or more repositories.
 *
 * Single repo: `repos` contains one entry with path ".".
 * Anchor repo (workspace itself is not a repo but contains sub-repos):
 * `repos` contains one entry per discoverable sub-repo.
 */
export interface GitContext {
	repos: GitRepoState[];
}

/**
 * A document file tracked for the handoff's `## Document Files` section
 * (definition: domain/document-files.ts — allowlist + denylist, D4).
 */
export interface DocumentFile {
	/** Absolute, normalized path. */
	path: string;
	/**
	 * `in-session` = written/edited via this session's tool calls;
	 * `git-only` = only visible in git status. A tool-log hit wins when both
	 * sources see the same file — never created/edited (unknowable: `write`
	 * overwrites).
	 */
	provenance: "in-session" | "git-only";
}

export interface HandoffOriginData {
	parentSession: string | undefined;
	goal: string | null;
	timestamp: number;
	/**
	 * Full PA-stripped handoff document with its provenance line — the
	 * durable audit trail of what the new session was seeded with. Lives in
	 * `details`, which serialization never maps to the LLM (only `content`
	 * becomes a user message), so the document is not duplicated into
	 * requests or compaction. Omitted for non-handoff (`/continue <text>`)
	 * launches. (Replaces the pre-rehaul `docPath` — documents are no longer
	 * files, design D11.)
	 */
	document?: string;
	/**
	 * `resolvePiAgentDir()` value at creation time. No profile API exists —
	 * the pi agent dir is the only profile signal the extension touches (D8).
	 */
	profile: string;
}

/**
 * Which terminal multiplexer to use for auto-submit during handoff.
 *
 * - `"tmux"` (default): uses `tmux send-keys` to confirm the editor overlay.
 * - `"herdr"`: uses `herdr pane send-keys` and stores pane context in
 *   shared memory so other extensions can locate this session.
 */
export type TerminalMode = "tmux" | "herdr";

export type HandoffMode = "detached" | "in-session";

export interface HandoffSettings {
	/**
	 * @deprecated Parsed for backward compatibility, ignored. The unified flow
	 * (2026-09-12) registers `/handoff`, `/continue`, and `continue` in EVERY
	 * session — this key no longer selects a registration
	 * path and has no effect. Kept in the parsed shape so existing
	 * settings.json files load without error; safe to delete from configs.
	 */
	type?: HandoffMode;

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

	/**
	 * Terminal multiplexer for auto-submit. Defaults to `"tmux"`.
	 */
	terminal?: TerminalMode;

	/**
	 * Whether /handoff nudges the agent to write a MemPalace diary entry
	 * before the handoff proceeds. Defaults to true when absent.
	 */
	diaryReminder?: boolean;

	/**
	 * Glob patterns for the handoff conversation's tool-traffic filter
	 * (infrastructure/tool-skip.ts). `*` matches zero or more characters and
	 * is the only metacharacter; matching is case-sensitive. Patterns apply
	 * to both assistant tool-call names and tool-result toolNames: matched
	 * call blocks are dropped and matched result content replaced by a
	 * one-line stub in the SERIALIZED handoff conversation only — the live
	 * session branch is never mutated and tool-result `details` (todo state)
	 * is preserved. A configured list REPLACES the defaults (copy-extend
	 * `DEFAULT_SKIP_TOOLS`); `[]` disables filtering entirely; a malformed
	 * value (non-array, or any non-string entry) is ignored with a warning
	 * and the defaults stay active. Absent = defaults active.
	 */
	skipTools?: string[];
}

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface HandoffContext {
	conversationText: string;
	/** Number of messages in the gathered session branch (user/assistant/tool results). */
	messageCount?: number;
	todos: string | null;
	git: GitContext | null;
	/** Document files created/edited this session — populated by the gatherer once git context lands. */
	documentFiles: DocumentFile[];
	skills: string | null;
	cwd: string;
	contextUsage: ContextUsage | undefined;
}

export interface HandoffPromptResult {
	prompt: string | null;
	error?: string;
	/** Id of the model that produced the prompt (on success). */
	modelId?: string;
	/** Provider of the model that produced the prompt (on success). */
	modelProvider?: string;
	/** Wall-clock duration of the generation attempt span, in ms (on success). */
	durationMs?: number;
	/** Length of the generated prompt, in characters (on success). */
	outputChars?: number;
}

/**
 * Payload emitted on the `tui_filled_handoff` event bus channel when a
 * handoff command is pre-filled in the editor. Emitted by the
 * `continue` tool / the `/handoff` executor (goal = the session title).
 * Payload content is informational — the auto-submit listener reads none of
 * it (it re-captures terminal context at emit time).
 */
export interface TuiFilledHandoffPayload {
	/** The session title derived from the document's `## Next Task`. */
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
	 * The terminal pane id captured at the START of the handoff flow (before LLM
	 * generation). When provided, the auto-submit listener uses this instead
	 * of re-capturing the active pane — which may have changed if the user
	 * switched terminal tabs during generation.
	 *
	 * This is a tmux pane id (e.g. "%5") or a herdr pane id (e.g. "w1:p1")
	 * depending on the configured terminal mode.
	 */
	paneId?: string | null;
}

// ── Herdr shared context ───────────────────────────────────────────────────

/**
 * Herdr pane coordinates captured from the environment.
 *
 * Stored in shared memory so other extensions and tools can locate the
 * pi session's position in the Herdr workspace hierarchy.
 */
export interface HerdrPaneContext {
	/** Herdr workspace id (e.g. "w1"). */
	workspaceId: string;
	/** Herdr tab id (e.g. "w1:t1"). */
	tabId: string;
	/** Herdr pane id (e.g. "w1:p1"). */
	paneId: string;
	/** When the context was captured (epoch ms). */
	timestamp: number;
}

// ── Lifecycle event payloads ──────────────────────────────────────────────

/**
 * Payload for `handoff_tool_start` / `handoff_tool_end` lifecycle events.
 */
export interface HandoffToolEventPayload {
	/** The goal passed to the `request_handoff` tool. */
	goal: string;
	/** The suggested command that was pre-filled. */
	command: string;
	/** Epoch ms timestamp. */
	timestamp: number;
}

/**
 * Payload for `handoff_command_start` / `handoff_command_complete` events.
 */
export interface HandoffCommandEventPayload {
	/** The goal for the handoff (null when inferred). */
	goal: string | null;
	/** Whether quick mode was used (skips editor review). */
	quickMode: boolean;
	/** Epoch ms timestamp. */
	timestamp: number;
	/** Only on complete: the session title assigned. */
	sessionTitle?: string;
	/** Only on complete: path to the saved handoff document (data dir). */
	artifactPath?: string;
	/** Only on complete: error message if the handoff failed. */
	error?: string;
}
