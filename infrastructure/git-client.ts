/**
 * Git context adapter.
 *
 * Wraps local `git` invocations to collect branch, status, diff stat, and
 * recent commits. Failures are swallowed and reported as `null` so non-repos
 * are handled gracefully.
 */

import { execSync } from "node:child_process";
import type { GitContext } from "../domain/types";

function runGit(args: string, cwd: string): string {
	return execSync(`git ${args}`, {
		cwd,
		encoding: "utf8",
		stdio: "pipe",
		timeout: 5000,
	}).trim();
}

export function getGitContext(cwd: string): GitContext | null {
	try {
		const branch = runGit("rev-parse --abbrev-ref HEAD", cwd);
		const status = runGit("status --short", cwd);
		const diffStat = runGit("diff --stat HEAD", cwd);
		const recentCommits = runGit("log --oneline -8", cwd);
		return { branch, status, diffStat, recentCommits };
	} catch {
		return null;
	}
}
