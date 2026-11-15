/**
 * Context gathering application service.
 *
 * Orchestrates collection of conversation, todos, git state, skills, cwd, and
 * context usage into a single domain object.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HandoffContext } from "../domain/types";
import { planCarry } from "../domain/session-state-carry";
import type { CarryPlan, CarryRequest } from "../domain/session-state-carry";
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
	/** Null when no carry request was given. */
	carryPlan: CarryPlan | null;
}

export function gatherHandoffContext(
	ctx: ExtensionCommandContext,
	carryRequest?: CarryRequest,
): GatheredContext {
	const branch = ctx.sessionManager.getBranch();
	const handoffContext = buildHandoffContext(ctx);
	handoffContext.git = getGitContext(ctx.cwd, handoffContext.conversationText);
	// Document-file tracking consumes exactly what the git client already
	// fetched (no extra execs) plus this session's write/edit tool calls.
	handoffContext.documentFiles = extractDocumentFiles(
		handoffContext.git,
		getHandoffMessages(branch),
		documentDenyDirs(),
		ctx.cwd,
	);

	return {
		context: handoffContext,
		currentSessionFile: ctx.sessionManager.getSessionFile(),
		leafId: ctx.sessionManager.getLeafId(),
		hasConversation: handoffContext.conversationText.trim().length > 0,
		carryPlan: carryRequest ? planCarry(branch, carryRequest) : null,
	};
}
