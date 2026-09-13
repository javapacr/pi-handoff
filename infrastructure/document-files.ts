/**
 * Document-file extractor (design 2026-09-13-template-unification, D5).
 *
 * Union of two sources, deduped by resolved absolute path, filtered through
 * the domain document policy (domain/document-files.ts):
 *
 * 1. git status rows (primary) — parsed from the per-repo
 *    `git status --short --untracked-files=all` output the git client
 *    already fetched (zero extra execs). Modified/added/renamed/untracked
 *    rows are candidates; `R  old -> new` rows yield the NEW path; paths
 *    wrapped in double quotes are unquoted per git's `core.quotePath`
 *    convention before extension matching.
 * 2. session tool-log (secondary) — `write`/`edit` tool calls in assistant
 *    messages (block.type `toolCall`, keyed on `block.name` +
 *    `arguments.path`), mirroring upstream compaction's
 *    `extractFileOpsFromMessage` shape.
 *
 * Provenance: `in-session` (tool-log hit) wins over `git-only` when both
 * sources see the same path. Output order: `in-session` rows first, then
 * `git-only`, alphabetical by absolute path within each provenance group
 * (codepoint comparison — deterministic across locales).
 */

import { Buffer } from "node:buffer";
import { isAbsolute, join, normalize } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DocumentFile, GitContext, GitRepoState } from "../domain/types";
import { compareDocumentFiles, isDocumentPath } from "../domain/document-files";
import { handoffDataDir, resolvePiAgentDir } from "./config-repository";

/** Absolute deny prefixes resolved from the pi agent dir: `$AGENT_DIR/tmp`
 * and the handoff data dir (`$AGENT_DIR/data/pi-handoff` — handoff documents
 * themselves are reachable via `newestHandoffDocPath`, not tracked here). */
export function documentDenyDirs(): string[] {
	return [join(resolvePiAgentDir(), "tmp"), handoffDataDir()];
}

/** Status codes whose rows describe files that still exist and changed. */
const INCLUDE_CODES = new Set(["M", "A", "R"]);

/** One decoded escape: its bytes and how many chars it consumed. */
interface DecodedEscape {
	bytes: number[];
	consumed: number;
}

/** Decode the escape sequence following a backslash at `chars[i - 1]`. */
function decodeEscape(chars: string[], i: number): DecodedEscape | undefined {
	const next = chars[i];
	if (next === undefined) return undefined;
	if (next >= "0" && next <= "7") {
		let oct = next;
		let end = i + 1;
		while (
			oct.length < 3 &&
			chars[end] !== undefined &&
			chars[end]! >= "0" &&
			chars[end]! <= "7"
		) {
			oct += chars[end++];
		}
		return { bytes: [parseInt(oct, 8)], consumed: end - i };
	}
	switch (next) {
		case "n":
			return { bytes: [0x0a], consumed: 1 };
		case "t":
			return { bytes: [0x09], consumed: 1 };
		case "r":
			return { bytes: [0x0d], consumed: 1 };
		default:
			return { bytes: [...Buffer.from(next, "utf8")], consumed: 1 };
	}
}

/**
 * Decode a git C-quoted path (`core.quotePath`): a double-quoted string with
 * backslash escapes — octal escapes carry raw UTF-8 bytes, so decoding is
 * byte-level before the final UTF-8 render. Unquoted input passes through.
 */
function unquoteGitPath(raw: string): string {
	if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
	const chars = [...raw.slice(1, -1)]; // code points — surrogate pairs stay intact
	const bytes: number[] = [];
	for (let i = 0; i < chars.length; i++) {
		if (chars[i] !== "\\") {
			bytes.push(...Buffer.from(chars[i]!, "utf8"));
			continue;
		}
		const escape = decodeEscape(chars, i + 1);
		if (!escape) break;
		bytes.push(...escape.bytes);
		i += escape.consumed;
	}
	return Buffer.from(bytes).toString("utf8");
}

/**
 * Candidate absolute paths from one repo's `status --short` output (already
 * fetched with `--untracked-files=all`, so untracked directories arrive
 * expanded to individual files). Deleted rows are skipped — there is no file
 * left to hand off.
 */
function parseGitStatusPaths(repo: GitRepoState): string[] {
	const out: string[] = [];
	for (const line of repo.status.split("\n")) {
		if (line.length <= 3 || line[2] !== " ") continue;
		const x = line[0]!;
		const y = line[1]!;
		const untracked = x === "?" && y === "?";
		if (!untracked && !INCLUDE_CODES.has(x) && !INCLUDE_CODES.has(y)) {
			continue;
		}
		let portion = line.slice(3);
		// Rename rows (`old -> new`): the NEW path is the material. Git quotes
		// each side independently (`"old" -> "new"`), so split BEFORE
		// unquoting — try the quoted separator first, fall back to the LAST
		// plain arrow (unquoted paths may themselves contain " -> ").
		const quotedArrow = portion.lastIndexOf('" -> "');
		const arrow =
			quotedArrow !== -1 ? quotedArrow : portion.lastIndexOf(" -> ");
		if (arrow !== -1) {
			// Right side may be quoted even when the left is plain (and vice
			// versa) — unquote is a no-op for unquoted portions.
			portion = unquoteGitPath(
				portion.slice(arrow + (quotedArrow !== -1 ? 5 : 4)),
			);
		} else if (portion.startsWith('"')) {
			portion = unquoteGitPath(portion);
		}
		out.push(join(repo.workingDirectory, portion));
	}
	return out;
}

/** Path argument of a write/edit toolCall block — undefined for any other block. */
function writeEditPath(block: unknown): string | undefined {
	if (typeof block !== "object" || block === null) return undefined;
	if (!("type" in block) || block.type !== "toolCall") return undefined;
	if (!("name" in block) || (block.name !== "write" && block.name !== "edit")) {
		return undefined;
	}
	if (!("arguments" in block)) return undefined;
	const args = block.arguments;
	if (typeof args !== "object" || args === null) return undefined;
	const path = (args as Record<string, unknown>).path;
	return typeof path === "string" ? path : undefined;
}

/** `write`/`edit` tool-call paths from one assistant message (may be empty). */
function toolCallPaths(message: AgentMessage): string[] {
	if (message.role !== "assistant") return [];
	if (!("content" in message) || !Array.isArray(message.content)) return [];
	const paths: string[] = [];
	for (const block of message.content) {
		const path = writeEditPath(block);
		if (path) paths.push(path);
	}
	return paths;
}

/** Resolve a tool-call path (absolute as given, else against the session cwd). */
function resolveToolPath(rawPath: string, cwd: string): string {
	return normalize(isAbsolute(rawPath) ? rawPath : join(cwd, rawPath));
}

/**
 * Extract the handoff document-file list: git status rows + session
 * write/edit calls, filtered through `isDocumentPath`, deduped by resolved
 * absolute path with `in-session` provenance winning. Dedupe uses
 * `normalize()`, NOT realpath — a symlinked git toplevel vs session cwd
 * divergence (e.g. /var ↔ /private/var) can double-list one file; accepted
 * trade-off: no filesystem syscalls on the extraction path.
 */
export function extractDocumentFiles(
	git: GitContext | null,
	messages: readonly AgentMessage[],
	denyDirs: readonly string[],
	cwd: string,
): DocumentFile[] {
	const byPath = new Map<string, DocumentFile>();

	// Primary: git status rows (provisionally `git-only` — the tool-log pass
	// overwrites hits with `in-session`).
	if (git) {
		for (const repo of git.repos) {
			for (const abs of parseGitStatusPaths(repo)) {
				if (!isDocumentPath(abs, denyDirs)) continue;
				byPath.set(abs, { path: abs, provenance: "git-only" });
			}
		}
	}

	// Secondary: this session's write/edit calls (`in-session` — wins).
	for (const message of messages) {
		for (const rawPath of toolCallPaths(message)) {
			const abs = resolveToolPath(rawPath, cwd);
			if (!isDocumentPath(abs, denyDirs)) continue;
			byPath.set(abs, { path: abs, provenance: "in-session" });
		}
	}

	const inSession: DocumentFile[] = [];
	const gitOnly: DocumentFile[] = [];
	for (const file of byPath.values()) {
		(file.provenance === "in-session" ? inSession : gitOnly).push(file);
	}
	inSession.sort(compareDocumentFiles);
	gitOnly.sort(compareDocumentFiles);
	return [...inSession, ...gitOnly];
}
