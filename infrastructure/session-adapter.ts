/**
 * Session adapter.
 *
 * Bridges pi's ExtensionContext / SessionManager APIs into domain shapes used
 * by the handoff application layer.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	convertToLlm,
	serializeConversation,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
	ContextUsage,
	HandoffContext,
	Task,
	TaskDetails,
	TodoDetails,
} from "../domain/types";

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

export function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}

	if (compactionIndex < 0) {
		return branch
			.map(entryToMessage)
			.filter((m): m is AgentMessage => m !== undefined);
	}

	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction.type === "compaction"
			? branch.findIndex((e) => e.id === compaction.firstKeptEntryId)
			: -1;

	const compactedBranch = [
		compaction,
		...(firstKeptIndex >= 0
			? branch.slice(firstKeptIndex, compactionIndex)
			: []),
		...branch.slice(compactionIndex + 1),
	];

	return compactedBranch
		.map(entryToMessage)
		.filter((m): m is AgentMessage => m !== undefined);
}

/**
 * Extract the todo/task list from the session branch.
 *
 * Handles both the built-in pi todo tool (`details.todos` with
 * `{ id, text, done }`) and the rpiv-todo extension
 * (`details.tasks` with `{ id, subject, status }`).
 */
export function extractTodos(branch: SessionEntry[]): string | null {
	let lastTodos: string[] | null = null;

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
		const details = msg.details as
			| (TaskDetails & Partial<TodoDetails>)
			| undefined;

		// rpiv-todo: details.tasks with { id, subject, status }
		if (details?.tasks && Array.isArray(details.tasks)) {
			const tasks = (details.tasks as Task[]).filter(
				(t) => t.status !== "deleted",
			);
			if (tasks.length > 0) {
				lastTodos = tasks.map((t) => {
					const check = t.status === "completed" ? "x" : " ";
					return `- [${check}] ${t.subject}`;
				});
			}
			continue;
		}

		// Built-in: details.todos with { id, text, done }
		if (details?.todos && Array.isArray(details.todos)) {
			if (details.todos.length > 0) {
				lastTodos = details.todos.map(
					(t) => `- [${t.done ? "x" : " "}] ${t.text}`,
				);
			}
		}
	}

	if (!lastTodos || lastTodos.length === 0) return null;
	return lastTodos.join("\n");
}

export function extractSkillList(ctx: ExtensionCommandContext): string | null {
	const systemPromptOptions = ctx.getSystemPromptOptions();
	const skills = systemPromptOptions.skills;
	if (!skills?.length) return null;

	return skills
		.map((s: { name: string; description?: string }) =>
			s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}`,
		)
		.join("\n");
}

export function extractContextUsage(
	ctx: ExtensionCommandContext,
): ContextUsage | undefined {
	const usage = ctx.getContextUsage();
	if (!usage) return undefined;
	return {
		tokens: usage.tokens ?? null,
		contextWindow: usage.contextWindow,
		percent: usage.percent ?? null,
	};
}

export function buildConversationText(ctx: ExtensionCommandContext): string {
	const branch = ctx.sessionManager.getBranch();
	const messages = getHandoffMessages(branch);
	return serializeConversation(convertToLlm(messages));
}

export function buildHandoffContext(
	ctx: ExtensionCommandContext,
): HandoffContext {
	const branch = ctx.sessionManager.getBranch();
	return {
		conversationText: buildConversationText(ctx),
		todos: extractTodos(branch),
		git: null, // populated separately by the git client
		skills: extractSkillList(ctx),
		cwd: ctx.cwd,
		contextUsage: extractContextUsage(ctx),
	};
}
