#!/usr/bin/env node
/**
 * Captures the golden fixture test/fixtures/session-states-v1.json from the
 * upstream pi-session-states `toDraft` / `replay` output.
 *
 * Usage: npx tsx scripts/capture-session-states-fixture.mjs <pi-session-states root> [out]
 *
 * Upstream is loaded by a computed import() path, never a static specifier or
 * a package dependency: pi-handoff must not import pi-session-states.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PINNED_REV = "515187bc0608f9d1f1c92bd90cb2e6865df4cb7e";
const REGENERATE =
	"npx tsx scripts/capture-session-states-fixture.mjs ~/.pi/agent/git/github.com/javapacr/pi-session-states";

const root = process.argv[2];
if (!root) {
	console.error("usage: capture-session-states-fixture.mjs <pi-session-states root> [out]");
	process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[3] ?? join(here, "../test/fixtures/session-states-v1.json"));

const upstreamRev = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
	encoding: "utf8",
}).trim();
if (upstreamRev !== PINNED_REV) {
	console.error(`warning: upstream rev ${upstreamRev} is not the pinned ${PINNED_REV}`);
}

const state = await import(pathToFileURL(join(root, "src/state.ts")).href);
const { toDraft, replay, isOwnMark } = state;

const transition = (to, from = null, who = "agent") =>
	toDraft({ kind: "transition", who, from, to });
const check = (stateName, id, evidence, who) =>
	toDraft({ kind: "check", state: stateName, id, evidence, ...(who ? { who } : {}) });
const entered = (to) => ({
	type: "custom_message",
	customType: state.ENTERED_MESSAGE_TYPE,
	content: `Entered session state: ${to}\n\n(body)`,
	display: true,
	details: { to },
});
const snapshot = {
	type: "custom_message",
	customType: state.SNAPSHOT_MESSAGE_TYPE,
	content: "Session state: build (update)\n\n(body)",
	display: false,
	details: { mode: "active", state: "build" },
};
const reminder = {
	type: "custom_message",
	customType: state.ENTRY_PREFIX + "reminder",
	content: "(reminder)",
	display: false,
};

const withVersion = (entry, v) => ({ ...entry, data: { ...entry.data, v } });

const branches = {
	"active-build": [
		transition("classify"),
		check("classify", "scope", "c1"),
		entered("classify"),
		transition("build", "classify"),
		snapshot,
		check("build", "tests", "ev1", "flag"),
		check("build", "review", "approved", "user"),
		check("build", "tests", "ev2"),
		check("classify", "scope", "late"),
		toDraft({ kind: "nudge", state: "build", unmet: ["x"], count: 1 }),
		toDraft({ kind: "window", run: 2 }),
		reminder,
	],
	"active-one": [transition("build", null, "flag"), check("build", "tests", "ok")],
	off: [transition("build"), check("build", "tests", "ev1"), toDraft({ kind: "off" })],
	dormant: [
		toDraft({ kind: "window", run: 3 }),
		toDraft({ kind: "dormant", reason: "window-expired" }),
	],
	unset: [toDraft({ kind: "window", run: 1 })],
	"messages-only": [entered("build"), reminder, snapshot],
	"drift-version": [transition("build"), withVersion(check("build", "tests", "e"), 2)],
	"drift-kind": [
		transition("build"),
		{ type: "custom", customType: "session-states:pause", data: { v: 1, kind: "pause" } },
	],
	"drift-mismatch": [
		transition("build"),
		{
			type: "custom",
			customType: "session-states:check",
			data: transition("build", "build").data,
		},
	],
	"drift-who": [transition("build"), check("build", "tests", "e", "robot")],
};

/** The last check per id after the last transition, for the current state. */
function effectiveChecks(branch, current) {
	const lastTransition = branch
		.map((entry) => entry.customType)
		.lastIndexOf("session-states:transition");
	const byId = new Map();
	for (const entry of branch.slice(lastTransition + 1)) {
		if (entry.customType === "session-states:check" && entry.data.state === current) {
			byId.set(entry.data.id, entry.data);
		}
	}
	return byId;
}

const isOwnData = (data) => {
	const { v: _v, ...event } = data;
	return isOwnMark(event);
};

function buildScenario(name, branch) {
	const replayed = replay(branch);
	const scenario = { branch, replayed };
	if (name.startsWith("drift-")) return scenario;

	const effective =
		replayed.mode === "active" ? effectiveChecks(branch, replayed.current) : new Map();
	let drafts = [];
	if (replayed.mode === "active") {
		drafts = [
			toDraft({ kind: "transition", who: "flag", from: null, to: replayed.current }),
			...Object.entries(replayed.marks).map(([id, evidence]) => {
				const who = effective.get(id)?.who;
				return toDraft({
					kind: "check",
					state: replayed.current,
					id,
					evidence,
					...(who ? { who } : {}),
				});
			}),
		];
	} else if (replayed.mode === "off") {
		drafts = [toDraft({ kind: "off" })];
	}
	scenario.expectedSeed = drafts.map((draft) => {
		const { type: _type, ...rest } = draft;
		return rest;
	});
	scenario.seedReplayed = replay(scenario.expectedSeed.map((seed) => ({ type: "custom", ...seed })));

	if (replayed.mode === "active") {
		scenario.ownMarkIdsBranch = [...effective]
			.filter(([, data]) => isOwnData(data))
			.map(([id]) => id);
		scenario.ownMarkIdsSeed = scenario.expectedSeed
			.filter((seed) => seed.customType === "session-states:check" && isOwnData(seed.data))
			.map((seed) => seed.data.id);
	}
	return scenario;
}

const scenarios = Object.fromEntries(
	Object.entries(branches).map(([name, branch]) => [name, buildScenario(name, branch)]),
);

const fixture = { upstreamRev, regenerate: REGENERATE, scenarios };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${out}`);
