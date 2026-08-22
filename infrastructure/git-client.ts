/**
 * Git context adapter.
 *
 * Wraps local `git` invocations to collect branch, status, diff stat, and
 * recent commits. When the workspace itself is a git repo, a single repo
 * entry is returned. When the workspace is an *anchor repo* (not a git repo
 * itself but containing sub-directory git repos), each sub-repo's state is
 * gathered individually.
 *
 * Failures are swallowed and reported as `null` so non-repos are handled
 * gracefully.
 */

import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { GitContext, GitRepoState } from "../domain/types";

function runGit(args: string, cwd: string): string {
	return execSync(`git ${args}`, {
		cwd,
		encoding: "utf8",
		stdio: "pipe",
		timeout: 5000,
	}).trim();
}

/**
 * Quick check whether a directory is inside a git work tree.
 */
function isGitRepo(dir: string): boolean {
	try {
		execSync("git rev-parse --is-inside-work-tree", {
			cwd: dir,
			encoding: "utf8",
			stdio: "pipe",
			timeout: 2000,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Gather full git state for a single repository.
 */
function getRepoState(repoPath: string, displayPath: string): GitRepoState {
	return {
		workingDirectory: runGit("rev-parse --show-toplevel", repoPath),
		path: displayPath,
		branch: runGit("rev-parse --abbrev-ref HEAD", repoPath),
		status: runGit("status --short", repoPath),
		diffStat: runGit("diff --stat HEAD", repoPath),
		recentCommits: runGit("log --oneline -8", repoPath),
	};
}

/**
 * Extract absolute file paths from conversation text, resolve each to its
 * git root, and return repo states for any not already discovered.
 */
function discoverReposFromConversation(
	text: string,
	knownRoots: Set<string>,
): GitRepoState[] {
	const repos: GitRepoState[] = [];

	// Match absolute Unix paths containing at least one path separator and
	// a file extension — surfaces source files discussed in the conversation.
	const pathRegex = /\/[\w./-]+\.[\w]+/g;
	const matches = text.match(pathRegex);
	if (!matches) return repos;

	for (const filePath of new Set(matches)) {
		try {
			const root = runGit("rev-parse --show-toplevel", dirname(filePath));
			if (knownRoots.has(root)) continue;
			knownRoots.add(root);
			repos.push(getRepoState(root, root));
		} catch {
			// Path doesn't exist or isn't in a git repo — skip.
		}
	}

	return repos;
}

/**
 * Gather git context from the workspace.
 *
 * If `cwd` itself is a git repo, returns a single-entry result. Otherwise,
 * treats `cwd` as an anchor repo and scans immediate sub-directories for
 * nested git repos. Additionally, scans `conversationText` for absolute file
 * paths to discover repos explored during the session (e.g. during planning
 * phases) that live outside the workspace.
 */
export function getGitContext(
	cwd: string,
	conversationText?: string,
): GitContext | null {
	const repos: GitRepoState[] = [];
	const knownRoots = new Set<string>();

	// 1. Check if cwd itself is a git repo.
	if (isGitRepo(cwd)) {
		try {
			const state = getRepoState(cwd, ".");
			knownRoots.add(state.workingDirectory);
			repos.push(state);
		} catch {
			// fall through to anchor scan
		}
	}

	// 2. Anchor repo: scan immediate sub-directories for nested git repos.
	if (repos.length === 0) {
		try {
			const entries = readdirSync(cwd, { withFileTypes: true });
			const subdirs = entries
				.filter((e) => e.isDirectory() && !e.name.startsWith("."))
				.map((e) => join(cwd, e.name));

			for (const dir of subdirs) {
				if (!isGitRepo(dir)) continue;
				try {
					const state = getRepoState(dir, relative(cwd, dir));
					knownRoots.add(state.workingDirectory);
					repos.push(state);
				} catch {
					// Skip repos with git errors — don't fail the whole handoff.
				}
			}
		} catch {
			// readdir failed — can't scan
		}
	}

	// 3. Conversation-based discovery: find repos explored during the session
	//    but not located in the current workspace.
	if (conversationText) {
		repos.push(...discoverReposFromConversation(conversationText, knownRoots));
	}

	return repos.length > 0 ? { repos } : null;
}
