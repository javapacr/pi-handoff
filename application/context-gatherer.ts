/**
 * Context gathering application service.
 *
 * Orchestrates collection of conversation, todos, git state, skills, cwd, and
 * context usage into a single domain object.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HandoffContext } from "../domain/types";
import { getGitContext } from "../infrastructure/git-client";
import { buildHandoffContext } from "../infrastructure/session-adapter";

export interface GatheredContext {
	context: HandoffContext;
	currentSessionFile: string | undefined;
	leafId: string | null;
	hasConversation: boolean;
}

export function gatherHandoffContext(
	ctx: ExtensionCommandContext,
): GatheredContext {
	const handoffContext = buildHandoffContext(ctx);
	handoffContext.git = getGitContext(ctx.cwd);

	return {
		context: handoffContext,
		currentSessionFile: ctx.sessionManager.getSessionFile(),
		leafId: ctx.sessionManager.getLeafId(),
		hasConversation: handoffContext.conversationText.trim().length > 0,
	};
}
