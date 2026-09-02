/**
 * Shared handoff output template.
 *
 * Single source of truth for the handoff document contract, used by BOTH
 * generation paths:
 *
 * - detached (`buildSystemPrompt` in application/prompt-generator.ts): the
 *   template is embedded in the system prompt of a one-off LLM call.
 * - in-session (commands/handoff-in-session.ts): the template is embedded in
 *   the instruction turn injected into the live session, which writes the doc
 *   to disk and calls the `continue` tool.
 *
 * Keep these constants byte-stable: the detached prompt's output shape and
 * the in-session doc shape must stay identical so `/continue` can
 * process either.
 */

/**
 * Goal-conditional framing block. Identical wording in both modes.
 */
export function handoffGoalBlock(goal: string | null): string {
	return goal
		? `The user has indicated the next session should focus on: "${goal}". Tailor the entire handoff doc toward this goal — emphasise relevant context, de-prioritise unrelated work, and make the next task align with this focus.`
		: `No explicit goal was provided. Read the conversation and infer the most logical next task or continuation. Use it as the ## Next Task section.`;
}

/**
 * Non-negotiable content rules (redaction, artifact dedup, skills section).
 */
export const HANDOFF_CRITICAL_RULES = `CRITICAL RULES:
1. REDACT all sensitive information — API keys, passwords, tokens, credentials, secrets, and personally identifiable information (PII). Replace with [REDACTED] placeholders. Never reproduce secrets in the output.
2. Do NOT duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by file path or URL instead. Summarise the key decisions or outcomes briefly but point to the source artifact for full detail.
3. Include a Suggested Skills section recommending skills the new agent should invoke based on the work context and task type.`;

/**
 * Canonical Phase Adherence section — appended by the `continue` tool to the
 * Next Task payload to form the new session's live first message. The
 * extension owns this text so model-authored variants (which may carry
 * arbitrary directives) never leak into the next session's opening prompt.
 */
export const HANDOFF_PHASE_ADHERENCE = `## Phase Adherence
This is a handoff from a previous session. Phase adherence as defined in the system prompt is mandatory — classify this request through CLASSIFICATION and follow the appropriate phase workflow. Do not skip phases.`;

/**
 * The exact output format — from `## Context` through the `## Phase Adherence`
 * paragraph. Sections before this in each mode's prompt provide the framing;
 * the IMPORTANT footer differs per mode (detached: stdout discipline,
 * in-session: file content discipline).
 */
export const HANDOFF_OUTPUT_TEMPLATE = `## Context
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

${HANDOFF_PHASE_ADHERENCE}`;
