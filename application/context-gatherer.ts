/**
 * Context gathering application service.
 *
 * Orchestrates collection of conversation, todos, git state, skills, cwd, and
 * context usage into a single domain object.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HandoffContext } from "../domain/types";
import { getGitContext } from "../infrastructure/git-client";
import {
	buildHandoffContext,
	getHandoffMessages,
} from "../infrastructure/session-adapter";
import {
	documentDenyDirs,
	extractDocumentFiles,
} from "../infrastructure/document-files";

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
	handoffContext.git = getGitContext(ctx.cwd, handoffContext.conversationText);
	// Document-file tracking consumes exactly what the git client already
	// fetched (no extra execs) plus this session's write/edit tool calls.
	handoffContext.documentFiles = extractDocumentFiles(
		handoffContext.git,
		getHandoffMessages(ctx.sessionManager.getBranch()),
		documentDenyDirs(),
		ctx.cwd,
	);

	return {
		context: handoffContext,
		currentSessionFile: ctx.sessionManager.getSessionFile(),
		leafId: ctx.sessionManager.getLeafId(),
		hasConversation: handoffContext.conversationText.trim().length > 0,
	};
}
