/**
 * Document-file policy (design 2026-09-13-template-unification, D4).
 *
 * What qualifies as a "document file" for the handoff's `## Document Files`
 * section: an allowlisted document extension under a path that survives the
 * denylist. Named constants by design — deliberately not config keys (same
 * rationale as HANDOFF_OUTPUT_TEMPLATE: the policy versions with the code
 * and adds no surface to the unvalidated settings passthrough).
 * `.json`/`.yaml` are excluded on purpose: config-shaped payloads, not
 * documents a reader should read before continuing.
 */

import { extname, normalize } from "node:path";
import type { DocumentFile } from "./types";

/** Extensions that qualify a path as a document file. */
export const DOCUMENT_EXTENSIONS: readonly string[] = [
	".md",
	".txt",
	".rst",
	".adoc",
];

/**
 * Path fragments never treated as handoff document material. The trailing
 * `/` marks each entry as a directory segment: matching compares path
 * segments, so `rebuild/x.md` is NOT denied while `build/x.md` is.
 */
export const DOCUMENT_PATH_DENYLIST: readonly string[] = [
	"node_modules/",
	".git/",
	"dist/",
	"build/",
];

const DENY_SEGMENTS = new Set(
	DOCUMENT_PATH_DENYLIST.map((fragment) => fragment.replace(/\/+$/, "")),
);

/**
 * Whether an absolute path qualifies as a document file: allowlisted
 * extension, no denylisted path segment, and not under one of `denyDirs`.
 * `denyDirs` are absolute directory prefixes the caller resolves via the
 * config repository — `$AGENT_DIR/tmp` and `$AGENT_DIR/data/pi-handoff`
 * (legacy on-disk handoff documents live there; the no-doc rehaul no longer
 * creates them, but old files stay denied — not doc-file-tracking
 * material). All comparisons run on normalized paths.
 */
export function isDocumentPath(
	rawPath: string,
	denyDirs: readonly string[],
): boolean {
	const p = normalize(rawPath);
	if (!DOCUMENT_EXTENSIONS.includes(extname(p).toLowerCase())) return false;

	const segments = p.split("/");
	if (segments.some((segment) => DENY_SEGMENTS.has(segment))) return false;

	for (const dir of denyDirs) {
		const prefix = normalize(dir).replace(/\/+$/, "");
		if (p === prefix || p.startsWith(prefix + "/")) return false;
	}
	return true;
}

/** Stable display order for extracted document files. */
export function compareDocumentFiles(a: DocumentFile, b: DocumentFile): number {
	if (a.path < b.path) return -1;
	if (a.path > b.path) return 1;
	return 0;
}
