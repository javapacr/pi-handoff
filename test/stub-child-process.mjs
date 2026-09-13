// Stub for node:child_process, applied ONLY to the staged extension tree
// (see the resolve hook in hooks.mjs — parentURL under the pih-stage- dir).
//
// `pbcopy` is recorded instead of executed: the W2 rescue paths
// (printHandoffFallback) copy the generated handoff to the clipboard, and
// the smoke must assert that WITHOUT mutating the user's real clipboard.
// Every other command delegates to the REAL builtin (the staged git-client
// still runs live `git status` in block 8).
import { createRequire } from "node:module";

const real = createRequire(import.meta.url)("node:child_process");

export const clipboardCalls = [];

export function execSync(cmd, opts) {
	if (String(cmd).trim() === "pbcopy") {
		clipboardCalls.push({ input: opts?.input, at: Date.now() });
		return "";
	}
	return real.execSync(cmd, opts);
}

export const execFile = real.execFile;
export const execFileSync = real.execFileSync;
export const spawn = real.spawn;
export const spawnSync = real.spawnSync;
export default real;
