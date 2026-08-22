/**
 * Prompt generation application service.
 *
 * Builds the system prompt and user payload, resolves the generation model,
 * and drives the LLM adapter inside the custom loader UI.
 */

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionCommandContext,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type {
	ContextUsage,
	GitContext,
	HandoffPromptResult,
	HandoffSettings,
} from "../domain/types";
import { generateWithModel } from "../infrastructure/llm-client";
import { HandoffLoader } from "../ui/handoff-loader";

/**
 * Match a model reference against the available models.
 *
 * Supports canonical `provider/modelId` references, explicit provider/model
 * splits, and bare model ids (only when unambiguous).
 */
function findExactModelReferenceMatch(
	modelReference: string,
	availableModels: Model<Api>[],
): Model<Api> | undefined {
	const trimmed = modelReference.trim();
	if (!trimmed) return undefined;

	const normalized = trimmed.toLowerCase();

	// Canonical provider/modelId reference, e.g. "deepseek/deepseek-v4-flash".
	const canonical = availableModels.find(
		(m) => `${m.provider}/${m.id}`.toLowerCase() === normalized,
	);
	if (canonical) return canonical;

	// Explicit provider/model split.
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmed.substring(0, slashIndex).trim();
		const modelId = trimmed.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const match = availableModels.find(
				(m) =>
					m.provider.toLowerCase() === provider.toLowerCase() &&
					m.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (match) return match;
		}
	}

	// Bare model id — only accept if unambiguous.
	const idMatches = availableModels.filter(
		(m) => m.id.toLowerCase() === normalized,
	);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

/**
 * Resolve the handoff generation model from settings, falling back to the active
 * model if the configured model is not available. Also returns the configured
 * thinking/effort level to use for generation.
 */
function resolveHandoffModel(
	activeModel: Model<Api>,
	registry: ModelRegistry,
	settings: HandoffSettings | null,
): { model: Model<Api>; effort: ThinkingLevel | undefined } {
	const effort = settings?.effort;

	// Preferred: explicit provider + bare model id.
	if (settings?.provider && settings?.model) {
		const configured = registry.find(settings.provider, settings.model);
		if (configured) {
			return { model: configured, effort };
		}
	}

	// Legacy: a single model field that may be a bare id or provider/model ref.
	if (settings?.model) {
		const configured = findExactModelReferenceMatch(
			settings.model,
			registry.getAvailable(),
		);
		if (configured) {
			return { model: configured, effort };
		}
	}

	return { model: activeModel, effort };
}

function buildSystemPrompt(goal: string | null): string {
	const goalBlock = goal
		? `The user has indicated the next session should focus on: "${goal}". Tailor the entire handoff doc toward this goal — emphasise relevant context, de-prioritise unrelated work, and make the next task align with this focus.`
		: `No explicit goal was provided. Read the conversation and infer the most logical next task or continuation. Use it as the ## Next Task section.`;

	return `You are a context transfer assistant. You receive a conversation history plus structured metadata (todos, git state, loaded skills, working directory, context usage).

${goalBlock}

Write a handoff document summarising the current conversation so a fresh agent can continue the work.

CRITICAL RULES:
1. REDACT all sensitive information — API keys, passwords, tokens, credentials, secrets, and personally identifiable information (PII). Replace with [REDACTED] placeholders. Never reproduce secrets in the output.
2. Do NOT duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by file path or URL instead. Summarise the key decisions or outcomes briefly but point to the source artifact for full detail.
3. Include a Suggested Skills section recommending skills the new agent should invoke based on the work context and task type.

The output must:
1. Summarise what was done and what matters (decisions, findings, approaches) — reference specs, plans, ADRs, issues by path/URL instead of reproducing them
2. Include relevant file paths that were discussed or modified
3. Carry forward the todo list (preserving done/pending state)
4. For each git repo involved (there may be multiple across different working directories), include the repo's working directory, branch, and key recent changes. Omit the Git State section entirely if no git repos were involved.
5. Suggest skills the new session should invoke based on the work context
6. State the next task clearly
7. End with the ## Next Task section — this is extracted and sent as the live prompt to the new session, followed by a ## Phase Adherence section

Use exactly this output format — omit any section that has no content:

## Context
[What was done, key decisions, approaches — 3-8 bullet points. Reference specs, plans, ADRs, issues by path/URL instead of duplicating.]

## Git State

### repo-name (/path/to/repo)
Branch: <branch>
Recent changes:
- path/to/file — what changed

Recent commits:
- abc1234 message

## Active Tasks
- [ ] pending task
- [x] completed task

## Suggested Skills
Invoke on start: skill-a, skill-b

## Working Directory
/path/to/project

## Next Task
[Clear, actionable statement of the goal for this new session]

## Phase Adherence
This is a handoff from a previous session. Phase adherence as defined in the system prompt is mandatory — classify this request through CLASSIFICATION and follow the appropriate phase workflow. Do not skip phases.

IMPORTANT: Always end with ## Phase Adherence as the final section. Output only the prompt — no preamble, no "Here is the prompt:".`;
}

function buildUserPayload(opts: {
	conversationText: string;
	todos: string | null;
	git: GitContext | null;
	skills: string | null;
	cwd: string;
	contextUsage: ContextUsage | undefined;
}): string {
	const sections: string[] = [
		`## Conversation History\n\n${opts.conversationText}`,
	];

	if (opts.todos) {
		sections.push(`## Current Todos\n\n${opts.todos}`);
	}

	if (opts.git && opts.git.repos.length > 0) {
		const isMultiRepo = opts.git.repos.length > 1;
		const repoSections = opts.git.repos.map((repo) => {
			const lines: string[] = [
				`Working directory: ${repo.workingDirectory}`,
				`Branch: ${repo.branch}`,
			];
			if (repo.status) lines.push(`\nUncommitted changes:\n${repo.status}`);
			if (repo.diffStat) lines.push(`\nDiff stat (HEAD):\n${repo.diffStat}`);
			if (repo.recentCommits)
				lines.push(`\nRecent commits:\n${repo.recentCommits}`);
			return isMultiRepo
				? `### ${repo.path}\n${lines.join("\n")}`
				: lines.join("\n");
		});
		sections.push(`## Git Context\n\n${repoSections.join("\n\n")}`);
	}

	if (opts.skills) {
		sections.push(`## Loaded Skills\n\n${opts.skills}`);
	}

	if (opts.contextUsage) {
		const { tokens, contextWindow, percent } = opts.contextUsage;
		const pct = percent != null ? `${percent.toFixed(0)}%` : "unknown";
		const tok =
			tokens != null
				? `${tokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`
				: `? / ${contextWindow.toLocaleString()} tokens`;
		sections.push(`## Context Usage\n\n${tok} (${pct} of context window)`);
	}

	sections.push(`## Working Directory\n\n${opts.cwd}`);

	return sections.join("\n\n");
}

export interface PromptGenerationInput {
	goal: string | null;
	conversationText: string;
	todos: string | null;
	git: GitContext | null;
	skills: string | null;
	cwd: string;
	contextUsage: ContextUsage | undefined;
}

export async function generateHandoffPrompt(
	ctx: ExtensionCommandContext,
	input: PromptGenerationInput,
	settings: HandoffSettings | null,
): Promise<HandoffPromptResult> {
	if (!ctx.model) {
		return { prompt: "", error: "No model selected" };
	}

	const systemPrompt = buildSystemPrompt(input.goal);
	const userPayload = buildUserPayload({
		conversationText: input.conversationText,
		todos: input.todos,
		git: input.git,
		skills: input.skills,
		cwd: input.cwd,
		contextUsage: input.contextUsage,
	});

	const loaderLabel = input.goal
		? "Generating handoff prompt…"
		: "Inferring goal and generating handoff prompt…";

	return ctx.ui.custom<HandoffPromptResult>((tui, theme, _kb, done) => {
		const loader = new HandoffLoader(tui, theme, loaderLabel, () =>
			done({ prompt: null }),
		);

		const doGenerate = async (): Promise<HandoffPromptResult> => {
			const { model: handoffModel, effort } = resolveHandoffModel(
				ctx.model!,
				ctx.modelRegistry,
				settings,
			);

			// Warn when the configured handoff model isn't available in the registry.
			if (settings?.model && handoffModel.id !== settings.model) {
				ctx.ui.notify(
					`Handoff model "${settings.model}" not available; using active model "${handoffModel.id}"`,
					"info",
				);
			}

			// Try configured model first; fall back to active model on failure.
			const modelsToTry: Model<Api>[] = [handoffModel];
			if (handoffModel !== ctx.model!) {
				modelsToTry.push(ctx.model!);
			}

			let lastError: string | undefined;

			for (const model of modelsToTry) {
				try {
					const text = await generateWithModel(
						model,
						ctx.modelRegistry,
						{ systemPrompt, userPayload },
						loader.signal,
						effort,
					);

					if (text === null) {
						return { prompt: null }; // aborted
					}
					if (text.trim()) {
						return { prompt: text };
					}
				} catch (err) {
					lastError =
						err instanceof Error
							? err.message
							: `Model ${model.id} failed: ${String(err)}`;
					// Notify so the user sees per-model failures before the final error.
					ctx.ui.notify(lastError, "error");
				}
			}

			return {
				prompt: "",
				error:
					lastError ??
					"No handoff content was generated by any available model.",
			};
		};

		doGenerate()
			.then(done)
			.catch((err) => {
				console.error("Handoff generation failed:", err);
				done({
					prompt: null,
					error:
						err instanceof Error
							? err.message
							: `Handoff generation failed: ${String(err)}`,
				});
			});

		return loader;
	});
}
