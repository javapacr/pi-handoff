/**
 * Session-state carry: the pure decision of what a handoff seeds into the new
 * session when the old one runs under pi-session-states.
 *
 * Deliberately has no imports: pi-handoff loads no state config and never
 * depends on the pi-session-states package. It carries its own minimal replay
 * of the v1 event schema, guarded by a golden fixture captured from upstream
 * (test/fixtures/session-states-v1.json). Shared by the `/handoff` executor,
 * the `/continue` launch and (later) the detached payload.
 */

export const SESSION_STATES_PREFIX = "session-states:";
export const SESSION_STATES_EVENT_VERSION = 1;

export type SessionStatesWho = "flag" | "agent" | "user";

type SessionStatesMode = "unset" | "active" | "dormant" | "off";

export type SessionStatesReplayState = {
	mode: SessionStatesMode;
	current: string | null;
	marks: Record<string, string>;
	markWho: Record<string, SessionStatesWho>;
	path: string[];
};

export type SessionStatesReplay =
	| { kind: "absent" }
	| { kind: "drift" }
	| { kind: "ok"; state: SessionStatesReplayState };

export type CarryRequest =
	| {
			via: "handoff";
			goal: string | null;
			override: "keep" | "route" | null;
	  }
	| { via: "continue"; nextState: string | null };

export type SeedEntry = { customType: string; data: Record<string, unknown> };

export type CarryPlan = {
	decision: "keep" | "route";
	routeTo: string | null;
	replay: SessionStatesReplay;
	seed: SeedEntry[];
	stampLine: string | null;
};

export type ParsedHandoffArgs =
	| { ok: true; goal: string | null; override: "keep" | "route" | null }
	| { ok: false; error: string };

const KNOWN_KINDS: ReadonlySet<string> = new Set([
	"transition",
	"check",
	"nudge",
	"window",
	"dormant",
	"off",
]);
const KNOWN_WHO: ReadonlySet<unknown> = new Set(["flag", "agent", "user"]);

const FLAG_CONFLICT_ERROR =
	"/handoff: --keep-state and --route conflict — pass one of them";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isWho(value: unknown): value is SessionStatesWho {
	return KNOWN_WHO.has(value);
}

/** The persisted event of a counted entry, `"drift"` when malformed, null when not counted. */
function eventOf(entry: unknown): Record<string, unknown> | "drift" | null {
	if (!isRecord(entry) || entry.type !== "custom") return null;
	const customType = entry.customType;
	if (typeof customType !== "string") return null;
	if (!customType.startsWith(SESSION_STATES_PREFIX)) return null;

	const data = entry.data;
	if (!isRecord(data) || data.v !== SESSION_STATES_EVENT_VERSION) return "drift";
	if (typeof data.kind !== "string" || !KNOWN_KINDS.has(data.kind)) return "drift";
	if (data.kind !== customType.slice(SESSION_STATES_PREFIX.length)) return "drift";
	if (data.kind === "transition" && !isString(data.to)) return "drift";
	if (data.kind === "check") {
		if (
			!isString(data.state) ||
			!isString(data.id) ||
			!isString(data.evidence)
		) {
			return "drift";
		}
		if ("who" in data && data.who !== undefined && !isWho(data.who)) {
			return "drift";
		}
	}
	return data;
}

function emptyState(): SessionStatesReplayState {
	return { mode: "unset", current: null, marks: {}, markWho: {}, path: [] };
}

function reduce(
	state: SessionStatesReplayState,
	event: Record<string, unknown>,
): SessionStatesReplayState {
	switch (event.kind) {
		case "transition": {
			const to = String(event.to);
			return {
				...state,
				mode: "active",
				current: to,
				marks: {},
				markWho: {},
				path: [...state.path, to],
			};
		}
		case "check": {
			if (state.mode !== "active" || event.state !== state.current) return state;
			const id = String(event.id);
			const marks = { ...state.marks, [id]: String(event.evidence) };
			const markWho = { ...state.markWho };
			if (isWho(event.who)) markWho[id] = event.who;
			else delete markWho[id];
			return { ...state, marks, markWho };
		}
		case "dormant":
			return { ...state, mode: "dormant", current: null, marks: {}, markWho: {} };
		case "off":
			return { ...state, mode: "off", current: null, marks: {}, markWho: {} };
		default:
			return state;
	}
}

/**
 * Replay the session-states v1 events found in a branch. Only `type:"custom"`
 * entries whose customType starts with `session-states:` count; the
 * `custom_message` entries upstream also writes are ignored. One malformed
 * counted entry refuses the whole replay (`drift`).
 */
export function replaySessionStates(
	entries: readonly unknown[],
): SessionStatesReplay {
	let state = emptyState();
	let counted = 0;
	for (const entry of entries) {
		const event = eventOf(entry);
		if (event === null) continue;
		if (event === "drift") return { kind: "drift" };
		counted++;
		state = reduce(state, event);
	}
	return counted === 0 ? { kind: "absent" } : { kind: "ok", state };
}

/**
 * Parse `/handoff` args: leading exact `--keep-state` / `--route` tokens are
 * flags, everything after them is the goal verbatim.
 */
export function parseHandoffArgs(rawArgs: string): ParsedHandoffArgs {
	let rest = rawArgs;
	let keep = false;
	let route = false;
	for (;;) {
		const match = /^\s*(--keep-state|--route)(?=\s|$)/.exec(rest);
		if (!match) break;
		if (match[1] === "--keep-state") keep = true;
		else route = true;
		rest = rest.slice(match[0].length);
	}
	if (keep && route) return { ok: false, error: FLAG_CONFLICT_ERROR };
	const goal = rest.trimStart();
	return {
		ok: true,
		goal: goal.length > 0 ? goal : null,
		override: keep ? "keep" : route ? "route" : null,
	};
}

function decide(
	replay: SessionStatesReplay,
	request: CarryRequest,
): { decision: "keep" | "route"; routeTo: string | null } {
	if (request.via === "handoff") {
		const decision = request.override ?? (request.goal ? "route" : "keep");
		return { decision, routeTo: null };
	}
	const nextState = request.nextState?.trim() || null;
	const current =
		replay.kind === "ok" && replay.state.mode === "active"
			? replay.state.current
			: null;
	if (nextState === null || nextState === current) {
		return { decision: "keep", routeTo: null };
	}
	return { decision: "route", routeTo: nextState };
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function seedActiveState(state: SessionStatesReplayState): SeedEntry[] {
	const current = state.current ?? "";
	const checks = Object.entries(state.marks).map(([id, evidence]): SeedEntry => {
		const who = state.markWho[id];
		return {
			customType: `${SESSION_STATES_PREFIX}check`,
			data: {
				v: SESSION_STATES_EVENT_VERSION,
				kind: "check",
				state: current,
				id,
				evidence,
				...(who ? { who } : {}),
			},
		};
	});
	return [
		{
			customType: `${SESSION_STATES_PREFIX}transition`,
			data: {
				v: SESSION_STATES_EVENT_VERSION,
				kind: "transition",
				who: "flag",
				from: null,
				to: current,
			},
		},
		...checks,
	];
}

/**
 * Decide keep vs route for a launch and build the entries to seed plus the
 * stamp line stating what was seeded (not what takes effect in the new
 * session).
 */
export function planCarry(
	entries: readonly unknown[],
	request: CarryRequest,
): CarryPlan {
	const replay = replaySessionStates(entries);
	const { decision, routeTo } = decide(replay, request);
	const plan = (seed: SeedEntry[], stampLine: string | null): CarryPlan => ({
		decision,
		routeTo,
		replay,
		seed,
		stampLine,
	});

	if (replay.kind === "absent") return plan([], null);
	if (replay.kind === "drift") {
		return plan([], "Session state: not carried — unrecognized schema");
	}

	const state = replay.state;
	switch (state.mode) {
		case "off":
			return plan(
				[
					{
						customType: `${SESSION_STATES_PREFIX}off`,
						data: { v: SESSION_STATES_EVENT_VERSION, kind: "off" },
					},
				],
				"Session state: kept off",
			);
		case "dormant":
		case "unset":
			return plan([], `Session state: not carried — ${state.mode}`);
		case "active":
			if (decision === "route") {
				return plan(
					[],
					routeTo === null
						? "Session state: not carried — route"
						: `Session state: not carried — route to ${routeTo}`,
				);
			}
			return plan(
				seedActiveState(state),
				`Session state: kept ${state.current} (${plural(Object.keys(state.marks).length, "mark")} carried)`,
			);
	}
}
