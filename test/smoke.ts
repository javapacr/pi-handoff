/**
 * Load + behavioral smoke for pi-handoff (no-doc rehaul W1: the filled
 * template rides the `continue` toolCall; bare /continue recovers it and
 * launches the new session). Run: npm test (from the repo root).
 *
 * Self-staging: the repo package.json has no "type": "module" (tsx would
 * transform the extension as CJS and its require-hook bypasses ESM module
 * hooks), and the repo devDep versions of @earendil-works/* drift from pi's
 * runtime aliases. So we copy the repo's .ts tree into a temp ESM context,
 * register module hooks that stub those packages, and import the staged
 * index.ts. Generation runs for real through infrastructure/llm-client.ts —
 * the executor smoke supplies a capturing mock `ModelRegistry` whose
 * `complete` serves the canned handoff document (makeRegistryCapture below).
 *
 * Every scratch dir lives under os.tmpdir() and PI_CODING_AGENT_DIR is
 * repointed per block — the real ~/.pi is never touched.
 */
import {
	cpSync,
	mkdtempSync,
	writeFileSync,
	mkdirSync,
	readdirSync,
	statSync,
	existsSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { execSync } from "node:child_process";
import type { DocumentFile } from "../domain/types";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const stage = mkdtempSync(join(tmpdir(), "pih-stage-"));
cpSync(repoRoot, stage, {
	recursive: true,
	filter: (s) => {
		const rel = relative(repoRoot, s);
		if (
			rel
				.split(sep)
				.some((part) => ["node_modules", "dist", ".git", "test"].includes(part))
		)
			return false;
		return statSync(s).isDirectory() || s.endsWith(".ts");
	},
});
writeFileSync(join(stage, "package.json"), JSON.stringify({ type: "module" }));
const repo = stage;

const { default: handoffExtension } = await import(join(repo, "index.ts"));
const promptModule = await import(join(repo, "domain/handoff-prompt.ts"));
const {
	findNextTaskContent,
	buildContinuationPrompt,
	stripTrailingPhaseAdherence,
	deriveSessionTitle,
} = promptModule;
const { HANDOFF_OUTPUT_TEMPLATE, HANDOFF_TEMPLATE_VERSION } = await import(
	join(repo, "domain/handoff-template.ts")
);
const { PROVENANCE_HEADER_PREFIX } = await import(
	join(repo, "domain/provenance.ts")
);
// Clipboard recorder — the stub replaces node:child_process for the STAGED
// tree only (see hooks.mjs); importing the same module URL here yields the
// SAME instance the executor's rescue path records into.
const { clipboardCalls } = (await import(
	new URL("./stub-child-process.mjs", import.meta.url).href
)) as { clipboardCalls: Array<{ input: string | undefined }> };
const { extractDocumentFiles, documentDenyDirs } = await import(
	join(repo, "infrastructure/document-files.ts")
);
const { getGitContext } = await import(
	join(repo, "infrastructure/git-client.ts")
);
const { executeHandoff } = await import(
	join(repo, "application/handoff-executor.ts")
);

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
	if (cond) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}`, extra ?? "");
	}
}

const CANONICAL_PA =
	"## Phase Adherence\nThis is a handoff from a previous session. Phase adherence as defined in the system prompt is mandatory — classify this request through CLASSIFICATION and follow the appropriate phase workflow. Do not skip phases.";

/** Exact expected live first message — contract literal, independent of prod code. */
function continuationPrompt(provenanceLine: string, document: string): string {
	return `${provenanceLine}\n\n${document}\n\n${CANONICAL_PA}`;
}

const VALID_DOC =
	"# Handoff\n\n## Context\nDid stuff.\n\n## Next Task\nShip the redesign.\n\n## Phase Adherence\nmodel-authored variant";
const INVALID_DOC =
	"# Handoff\n\n## Context\nNo `## Next Task` section at all.";
/** PA-free minimal fixture for strip/passthrough checks. */
const PLAIN_DOC = "## Context\nDid the thing.\n\n## Next Task\nDo the thing.";
/** PLAIN_DOC with a model-authored trailing PA — the strip fixture. */
const DOC_WITH_TRAILING_PA = `${PLAIN_DOC}\n\n## Phase Adherence\nmodel-authored variant`;
/** VALID_DOC minus its trailing model-authored PA — expected normalized body. */
const STRIPPED_DOC = VALID_DOC.slice(
	0,
	VALID_DOC.indexOf("\n\n## Phase Adherence"),
);
const VALID_TASK = "Ship the redesign.";
const VALID_TITLE = deriveSessionTitle(null, VALID_TASK);

// ── scratch state ──

const scratchDirs: string[] = [];
/** mkdtemp scratch dir; writes settings.json only when `settings` is given. */
function scratchDir(prefix: string, settings?: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratchDirs.push(dir);
	if (settings !== undefined)
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	return dir;
}

// Remove every scratch dir on the way out — including when a crash aborts the
// suite mid-run.
process.on("exit", () => {
	for (const dir of [...scratchDirs, stage]) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

/** Recursive listing of `dir`, sorted — zero-writes assertions (D10/D11). */
function snapshotDirTree(dir: string): string[] {
	const out: string[] = [];
	if (!existsSync(dir)) return out;
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			out.push(e.isDirectory() ? `${p}/` : p);
			if (e.isDirectory()) walk(p);
		}
	};
	walk(dir);
	return out.sort();
}

/** Top-level entries of the system tmpdir; harness scratch (pih-*) excluded.
 * The first-class zero-writes invariant's third scope (design D12/D13). */
function snapshotTmpTop(): string[] {
	try {
		return readdirSync(tmpdir())
			.filter((e) => !e.startsWith("pih-"))
			.sort();
	} catch {
		return [];
	}
}

/** The three zero-writes scopes: agent dir + session cwd ("repo") + tmpdir. */
function zeroWritesSnapshot(
	agentDir: string,
	cwd: string,
): Record<string, string[]> {
	return {
		agentDir: snapshotDirTree(agentDir),
		cwd: snapshotDirTree(cwd),
		tmpTop: snapshotTmpTop(),
	};
}

/** Human-readable added/removed entries between two snapshots. */
function snapshotDiff(
	a: Record<string, string[]>,
	b: Record<string, string[]>,
): string {
	const out: string[] = [];
	for (const key of Object.keys(a)) {
		const setA = new Set(a[key]);
		const setB = new Set(b[key]);
		for (const p of b[key]) if (!setA.has(p)) out.push(`+ ${key}: ${p}`);
		for (const p of a[key]) if (!setB.has(p)) out.push(`- ${key}: ${p}`);
	}
	return out.join(", ");
}

// Deterministic terminal strategy: no multiplexer in the harness.
delete process.env.TMUX;
delete process.env.HERDR_ENV;

function makeMockPi() {
	const commands = new Map();
	const tools = new Map();
	const registrations: string[] = [];
	const eventsOn: Array<[string, Function]> = [];
	const apiOn: Array<[string, Function]> = [];
	const emitted: Array<{ ch: string; payload: any }> = [];
	const editorTexts: string[] = [];
	const pi: any = {
		registerCommand: (name: string, opts: any) => {
			registrations.push(`command:${name}`);
			commands.set(name, opts);
		},
		registerTool: (def: any) => {
			registrations.push(`tool:${def.name}`);
			tools.set(def.name, def);
		},
		registerShortcut: () => {},
		registerFlag: () => {},
		on: (event: string, handler: Function) => apiOn.push([event, handler]),
		events: {
			on: (ch: string, handler: Function) => eventsOn.push([ch, handler]),
			emit: (ch: string, payload: any) => emitted.push({ ch, payload }),
		},
		sendUserMessage: (_content: string, _opts: any) => {},
		setLabel: () => {},
		getActiveTools: () => ["mempalace_diary_write"],
		getAllTools: () => [{ name: "mempalace_diary_write" }],
	};
	return {
		pi,
		commands,
		tools,
		registrations,
		apiOn,
		eventsOn,
		emitted,
		editorTexts,
	};
}

type MockPi = ReturnType<typeof makeMockPi>;

function makeMockCtx(over: any = {}) {
	const branch = over.sessionBranch ?? [
		{ id: "e1", type: "message", message: { role: "user", content: "hello" } },
	];
	const mock = {
		mode: "tui",
		cwd: tmpdir(),
		model: { id: "stub-model", provider: "stub" },
		// Default staging sink — the default setEditorText below records here.
		editorTexts: [] as string[],
		modelRegistry: {
			getAvailable: () => [],
			find: () => undefined,
			// Tripwire: only executor runs carry the capturing registry.
			complete: async () => {
				throw new Error(
					"stub: registry.complete called in a non-generation smoke context",
				);
			},
		},
		ui: {
			notify: () => {},
			setEditorText: (t: string) => mock.editorTexts.push(t),
		},
		getSystemPromptOptions: () => ({}),
		getContextUsage: () => undefined,
		sessionManager: {
			getBranch: () => branch,
			getSessionFile: () => "/tmp/fake-session.jsonl",
			getLeafId: () => "leaf-1",
		},
		...over,
	} as any;
	return mock;
}

/** Captures what a mocked `ctx.newSession` is asked to seed. When
 * `cancelSession`, newSession returns `{cancelled: true}` WITHOUT running
 * setup/withSession and WITHOUT invalidating the extension ctx (no
 * replacement happened — post-cancel emits stay legal). */
function makeSessionCapture(cancelSession = false) {
	const state = {
		order: [] as string[],
		sessionInfo: [] as string[],
		appended: [] as any[],
		liveMessages: [] as string[],
		stale: false,
	};
	return {
		state,
		newSession: async (opts: any) => {
			state.order.push("newSession");
			if (cancelSession) return { cancelled: true };
			await opts.setup?.({
				appendSessionInfo: (t: string) => state.sessionInfo.push(t),
				appendMessage: (m: any) => state.appended.push(m),
			});
			await opts.withSession?.({
				sendUserMessage: async (t: string) => state.liveMessages.push(t),
				ui: { notify: () => {} },
			});
			state.stale = true;
			return { cancelled: false };
		},
	};
}

// ── 1. pure domain helpers ──
console.log("domain helpers:");
check(
	"missing heading → null",
	findNextTaskContent("## Context\nfoo") === null,
);
check(
	"empty section → null",
	findNextTaskContent("## Next Task\n\n## Phase Adherence\n") === null,
);
check(
	"content excludes trailing Phase Adherence section",
	findNextTaskContent(
		"## Context\nx\n\n## Next Task\nDo the thing.\n\n## Phase Adherence\nmodel variant",
	) === "Do the thing.",
);
check(
	"multiple headings → last wins",
	findNextTaskContent("## Next Task\nold\n\n## Next Task\nnew task") ===
		"new task",
);
check(
	"trailing model-authored PA stripped (last heading, final section)",
	stripTrailingPhaseAdherence(DOC_WITH_TRAILING_PA) === PLAIN_DOC,
);
check(
	"no trailing PA → byte passthrough",
	stripTrailingPhaseAdherence(PLAIN_DOC) === PLAIN_DOC,
);
check(
	"PA followed by a later section → untouched (not trailing)",
	stripTrailingPhaseAdherence(
		`${PLAIN_DOC}\n\n## Phase Adherence\nv\n\n## Afterword\nkept`,
	) === `${PLAIN_DOC}\n\n## Phase Adherence\nv\n\n## Afterword\nkept`,
);
check(
	"strip is idempotent",
	stripTrailingPhaseAdherence(
		stripTrailingPhaseAdherence(DOC_WITH_TRAILING_PA),
	) === PLAIN_DOC,
);
const LAUNCH_PROVENANCE =
	"<!-- pi-handoff v2 | session: /s.jsonl | saved: 2026-09-13T00:00:00.000Z -->";
check(
	"live message = provenance line + document + canonical PA",
	buildContinuationPrompt(LAUNCH_PROVENANCE, PLAIN_DOC) ===
		continuationPrompt(LAUNCH_PROVENANCE, PLAIN_DOC),
);
check(
	"invalid doc → continuation null",
	buildContinuationPrompt(LAUNCH_PROVENANCE, "## Context\nx") === null,
);
check(
	"live message opens with the provenance comment (never parsed as content)",
	buildContinuationPrompt(LAUNCH_PROVENANCE, PLAIN_DOC)!.startsWith(
		`${LAUNCH_PROVENANCE}\n\n`,
	),
);
check(
	"findNextTaskContent unaffected by a leading provenance comment line",
	findNextTaskContent(`${LAUNCH_PROVENANCE}\n\n${DOC_WITH_TRAILING_PA}`) ===
		"Do the thing.",
);
check(
	"title derives from Next Task first line",
	deriveSessionTitle(null, "Do the thing.\nmore detail") === "Do the thing.",
);

// ── 1b. template v2 contract: version + test-enforced skill mirror ──
console.log("template v2 + skill contract sync:");
// The staged tree copies only .ts files, so the skill is read from the
// ORIGINAL repo root — byte-equality against the rendered constant is
// unaffected: the constant and the skill ship in the same commit.
const skillSource = readFileSync(
	join(repoRoot, "skills", "pi-handoff", "SKILL.md"),
	"utf8",
);
const fenceMarker = "```markdown\n";
const fenceStart = skillSource.indexOf(fenceMarker);
const fenceEnd =
	fenceStart === -1 ? -1 : skillSource.indexOf("\n```", fenceStart);
const fencedContract =
	fenceStart === -1 || fenceEnd === -1
		? null
		: skillSource.slice(fenceStart + fenceMarker.length, fenceEnd);
check("template version constant is 2", HANDOFF_TEMPLATE_VERSION === 2);
check("skill has a markdown contract fence", fencedContract !== null);
check(
	"fenced contract block === rendered HANDOFF_OUTPUT_TEMPLATE",
	fencedContract === HANDOFF_OUTPUT_TEMPLATE,
	JSON.stringify(fencedContract?.slice(0, 200)),
);
check(
	"Document Files section sits between Git State and Active Tasks",
	HANDOFF_OUTPUT_TEMPLATE.indexOf("## Document Files") >
		HANDOFF_OUTPUT_TEMPLATE.indexOf("## Git State") &&
		HANDOFF_OUTPUT_TEMPLATE.indexOf("## Document Files") <
			HANDOFF_OUTPUT_TEMPLATE.indexOf("## Active Tasks"),
);
check(
	"## Next Task + Phase Adherence stay last and byte-identical",
	HANDOFF_OUTPUT_TEMPLATE.endsWith(
		"## Next Task\n[Clear, actionable statement of the goal for this new session]\n\n" +
			CANONICAL_PA,
	),
);
check(
	"splitHandoffPrompt removed (dead code deleted, import sites compile)",
	!("splitHandoffPrompt" in promptModule),
);

// ── 2. unified registration (handoff.type parsed but ignored) ──
console.log("unified registration:");
const shape = (p: MockPi) =>
	JSON.stringify({
		commands: [...p.commands.keys()].sort(),
		tools: [...p.tools.keys()].sort(),
		order: p.registrations,
	});

const agentInSession = scratchDir("pih-insession-", {
	handoff: { type: "in-session" },
});
process.env.PI_CODING_AGENT_DIR = agentInSession;
const s = makeMockPi();
handoffExtension(s.pi);
check("type=in-session → /handoff registered", s.commands.has("handoff"));
check("type=in-session → /continue registered", s.commands.has("continue"));
check(
	"type=in-session → request_handoff tool ABSENT",
	!s.tools.has("request_handoff"),
);
check("type=in-session → continue tool registered", s.tools.has("continue"));
check(
	"all three surfaces register in the documented order",
	JSON.stringify(s.registrations) ===
		JSON.stringify(["command:handoff", "command:continue", "tool:continue"]),
	String(s.registrations),
);
{
	// pi 1.0 packages.md "Declare dependencies": host-provided packages are
	// peerDependencies "*", never dependencies (pi warns at load otherwise).
	const manifest = JSON.parse(
		readFileSync(join(repoRoot, "package.json"), "utf-8"),
	);
	const hostProvided = [
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
		"typebox",
	];
	check(
		"manifest: host-provided packages are peerDependencies '*', none in dependencies",
		hostProvided.every((n) => manifest.peerDependencies?.[n] === "*") &&
			!hostProvided.some((n) => n in (manifest.dependencies ?? {})),
		JSON.stringify({
			dependencies: manifest.dependencies,
			peerDependencies: manifest.peerDependencies,
		}),
	);
}
check(
	"api hooks: session_start + agent_end",
	JSON.stringify(s.apiOn.map(([e]) => e).sort()) ===
		JSON.stringify(["agent_end", "session_start"]),
	JSON.stringify(s.apiOn.map(([e]) => e)),
);
check(
	"bus listeners: tui_filled_handoff ONLY (dead tui_handoff_completed listener deleted)",
	JSON.stringify(s.eventsOn.map(([c]) => c)) ===
		JSON.stringify(["tui_filled_handoff"]),
	JSON.stringify(s.eventsOn.map(([c]) => c)),
);
{
	const { HANDOFF_CHANNELS } = await import(
		join(repo, "infrastructure/event-channels.ts")
	);
	check(
		"tui_handoff_completed channel deleted from the bus map",
		!Object.values(HANDOFF_CHANNELS).includes("tui_handoff_completed"),
		JSON.stringify(HANDOFF_CHANNELS),
	);
}

const agentDetachedTyped = scratchDir("pih-detached-", {
	handoff: { type: "detached", provider: "zai", model: "glm-5.3" },
});
process.env.PI_CODING_AGENT_DIR = agentDetachedTyped;
const d = makeMockPi();
handoffExtension(d.pi);
check(
	"type=detached → identical surfaces + order",
	shape(d) === shape(s),
	`${shape(d)} vs ${shape(s)}`,
);
check(
	"type=detached → request_handoff tool absent",
	!d.tools.has("request_handoff"),
);

const agentTypeAbsent = scratchDir("pih-untyped-", {
	handoff: { provider: "zai", model: "glm-5.3", effort: "high" },
});
process.env.PI_CODING_AGENT_DIR = agentTypeAbsent;
const a = makeMockPi();
handoffExtension(a.pi);
check(
	"type absent → identical surfaces + order",
	shape(a) === shape(s),
	`${shape(a)} vs ${shape(s)}`,
);
check(
	"type absent → request_handoff tool absent",
	!a.tools.has("request_handoff"),
);

const agentNoSettings = scratchDir("pih-nosettings-");
process.env.PI_CODING_AGENT_DIR = agentNoSettings;
const n = makeMockPi();
handoffExtension(n.pi);
check(
	"no settings.json → identical surfaces + order",
	shape(n) === shape(s),
	`${shape(n)} vs ${shape(s)}`,
);
check(
	"no settings.json → all three surfaces present, request_handoff absent",
	n.commands.has("handoff") &&
		n.commands.has("continue") &&
		n.tools.has("continue") &&
		!n.tools.has("request_handoff"),
);

// ── 3. executor: /handoff → doc in the data dir → staged /continue ──
const agentExec = scratchDir("pih-exec-");
const execCwd = scratchDir("pih-exec-cwd-");
process.env.PI_CODING_AGENT_DIR = agentExec;

interface ExecutorRun {
	pi: MockPi;
	notes: Array<{ message: string; level: string | undefined }>;
	editorTexts: string[];
	order: string[];
	confirmCalls: number;
	compactCalls: number;
	editorCalls: number;
	newSessionCalls: number;
	registry: RegistryCapture;
	/** Seeded session payload + stale flag from the mocked newSession. */
	session: ReturnType<typeof makeSessionCapture>["state"];
	/** stderr text captured during the run (the rescue path writes there). */
	stderr: string;
	/** pbcopy calls recorded during the run (clipboard rescue). */
	clipboard: Array<{ input: string | undefined }>;
	/** agent-dir + cwd + tmpdir unchanged across the run (first-class invariant). */
	zeroWrites: boolean;
	zeroWritesDetail: string;
}

/** Mock `ModelRegistry` capture for the executor's generation path. */
interface RegistryCapture {
	/** Every `complete(model, context, options)` invocation, in order. */
	calls: Array<{ model: any; context: any; options: any }>;
	/** getApiKeyAndHeaders calls — must stay 0: the adapter must not
	 * hand-resolve auth (that hand-rolling is what dropped Bedrock env/baseUrl). */
	getApiKeyCalls: number;
	/** Model ids that hard-fail on generation (fallback-loop fixture). */
	failModelIds: string[];
	registry: any;
}

/** Models the executor mock registry offers; `stub-model` mirrors ctx.model. */
const EXECUTOR_MODELS = [
	{ id: "stub-model", provider: "stub" },
	{ id: "configured-model", provider: "stub" },
];

function makeRegistryCapture(doc: string): RegistryCapture {
	const capture: RegistryCapture = {
		calls: [],
		getApiKeyCalls: 0,
		failModelIds: [],
		registry: undefined,
	};
	capture.registry = {
		getAvailable: () => EXECUTOR_MODELS,
		find: (provider: string, id: string) =>
			EXECUTOR_MODELS.find((m) => m.provider === provider && m.id === id),
		getApiKeyAndHeaders: async () => {
			capture.getApiKeyCalls++;
			return { ok: true, apiKey: "key", headers: {} };
		},
		complete: async (model: any, context: any, options: any) => {
			capture.calls.push({ model, context, options });
			if (capture.failModelIds.includes(model.id)) {
				throw new Error(
					`Validation error: The provided model identifier is invalid (${model.id})`,
				);
			}
			if (!doc) {
				return {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "stub: executor smoke supplied no handoff document",
				};
			}
			return {
				role: "assistant",
				content: [{ type: "text", text: doc }],
				stopReason: "stop",
			};
		},
	};
	return capture;
}

/** Drive executeHandoff end-to-end with a canned generated document. */
async function runExecutor(
	doc: string,
	opts: {
		settings?: Record<string, unknown>;
		failModelIds?: string[];
		/** Session branch override — e.g. to exercise document-file extraction. */
		branch?: unknown[];
		/** Behavior of the mocked ctx.newSession (default: replace + succeed). */
		newSessionBehavior?: "ok" | "cancelled" | "throw";
	} = {},
): Promise<ExecutorRun> {
	const p = makeMockPi();
	const notes: Array<{ message: string; level: string | undefined }> = [];
	const editorTexts: string[] = [];
	const order: string[] = [];
	let confirmCalls = 0;
	let compactCalls = 0;
	let editorCalls = 0;
	let newSessionCalls = 0;

	const capture = makeRegistryCapture(doc);
	capture.failModelIds = opts.failModelIds ?? [];

	// Session capture + stale-emit tripwire: after newSession() settles, ANY
	// further emit on this extension instance throws (mirrors pi's
	// invalidation) — the complete-before-replace ordering must hold.
	const { state, newSession } = makeSessionCapture(
		opts.newSessionBehavior === "cancelled",
	);
	p.pi.events.emit = (ch: string, payload: any) => {
		if (state.stale)
			throw new Error(
				"This extension ctx is stale after session replacement or reload.",
			);
		order.push(`emit:${ch}`);
		p.emitted.push({ ch, payload });
	};
	const wiredNewSession = async (o: any) => {
		newSessionCalls++;
		// Same timeline as the emits — ordering asserts compare indices here.
		order.push("newSession");
		if (opts.newSessionBehavior === "throw") {
			throw new Error("newSession exploded (executor smoke fixture)");
		}
		return newSession(o);
	};

	// Zero-filesystem-writes scopes: agent dir + session cwd ("repo") + the
	// system tmpdir top level (harness scratch is pih-* prefixed, excluded).
	const before = zeroWritesSnapshot(agentExec, execCwd);

	// Capture stderr — the rescue path prints the generated text there.
	const stderrChunks: string[] = [];
	const realStderrWrite = process.stderr.write.bind(process.stderr);
	(process.stderr as any).write = (chunk: any, ..._rest: any[]) => {
		stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
		return true;
	};
	const clipBefore = clipboardCalls.length;

	const ctx = makeMockCtx({
		cwd: execCwd,
		modelRegistry: capture.registry,
		sessionBranch: opts.branch,
		newSession: wiredNewSession,
		ui: {
			notify: (message: string, level?: string) => notes.push({ message, level }),
			setEditorText: (t: string) => {
				order.push("setEditorText");
				editorTexts.push(t);
			},
			confirm: async () => {
				confirmCalls++;
				return true;
			},
			editor: async (_title: string, text: string) => {
				editorCalls++;
				return text;
			},
			custom: async (factory: any) =>
				new Promise((resolve) => {
					factory(
						{ requestRender: () => {} },
						{ fg: (_key: string, s: string) => s },
						{},
						(result: any) => resolve(result),
					);
				}),
		},
	});

	try {
		await executeHandoff(
			p.pi,
			ctx,
			{ rawArgs: "" },
			{ diaryReminder: false, terminal: "tmux", ...opts.settings },
		);
	} finally {
		(process.stderr as any).write = realStderrWrite;
	}

	const after = zeroWritesSnapshot(agentExec, execCwd);

	return {
		pi: p,
		notes,
		editorTexts,
		order,
		confirmCalls,
		compactCalls,
		editorCalls,
		newSessionCalls,
		registry: capture,
		session: state,
		stderr: stderrChunks.join(""),
		clipboard: clipboardCalls.slice(clipBefore),
		zeroWrites: JSON.stringify(before) === JSON.stringify(after),
		zeroWritesDetail: snapshotDiff(before, after),
	};
}

console.log("executor (valid doc): direct launch, zero filesystem writes:");
const run = await runExecutor(VALID_DOC);
const complete = run.pi.emitted.find(
	(e) => e.ch === "handoff_command_complete",
);
check("completion emitted", complete !== undefined);
check(
	"completion is success-tagged with the task-derived title, NO artifactPath field",
	!!complete &&
		complete.payload.error === undefined &&
		complete.payload.sessionTitle === VALID_TITLE &&
		!("artifactPath" in complete.payload),
	JSON.stringify(complete?.payload),
);
check(
	"doc NOT saved — agent dir + cwd + tmpdir unchanged across the flow",
	run.zeroWrites,
	run.zeroWritesDetail,
);
check("no ui.confirm call (compaction gate removed)", run.confirmCalls === 0);
check("no ctx.compact call", run.compactCalls === 0);
check("NO editor review", run.editorCalls === 0);
check("NO editor staging", run.editorTexts.length === 0);
check(
	"NO tui_filled_handoff / NO tui_handoff_completed emissions (direct launch)",
	!run.pi.emitted.some(
		(e) => e.ch === "tui_filled_handoff" || e.ch === "tui_handoff_completed",
	),
	JSON.stringify(run.pi.emitted.map((e) => e.ch)),
);
check(
	"executor creates the session DIRECTLY (exactly one newSession call)",
	run.newSessionCalls === 1,
	String(run.newSessionCalls),
);
check(
	"new session seeded with exactly ONE live message",
	run.session.liveMessages.length === 1,
	JSON.stringify(run.session.liveMessages),
);
{
	const live = run.session.liveMessages[0] ?? "";
	const firstLine = live.split("\n", 1)[0];
	const savedAt = firstLine.match(/ saved: (\S+) -->$/)?.[1];
	check(
		"live message first line is the machine-stamped provenance comment",
		firstLine ===
			`<!-- pi-handoff v${HANDOFF_TEMPLATE_VERSION} | session: /tmp/fake-session.jsonl | saved: ${savedAt} -->` &&
			savedAt !== undefined &&
			!Number.isNaN(Date.parse(savedAt)),
		JSON.stringify(live.slice(0, 120)),
	);
	check(
		"live message = provenance + PA-stripped document + canonical PA (W1 shape)",
		live === continuationPrompt(firstLine, STRIPPED_DOC),
		JSON.stringify(live),
	);
	check(
		"model-authored PA variant does not ride along; canonical PA is last",
		!live.includes("model-authored variant") && live.endsWith(CANONICAL_PA),
	);
	check(
		"origin entry carries details.document = provenance + stripped doc",
		run.session.appended.length === 1 &&
			run.session.appended[0].role === "custom" &&
			run.session.appended[0].customType === "handoff-origin" &&
			run.session.appended[0].details?.document ===
				`${firstLine}\n\n${STRIPPED_DOC}`,
		JSON.stringify(run.session.appended[0]?.details?.document?.slice(0, 120)),
	);
	check(
		"origin entry: goal/parent/profile preserved, no docPath",
		run.session.appended[0].details?.goal === null &&
			run.session.appended[0].details?.parentSession ===
				"/tmp/fake-session.jsonl" &&
			run.session.appended[0].details?.profile === agentExec &&
			!("docPath" in (run.session.appended[0].details ?? {})),
		JSON.stringify(run.session.appended[0].details),
	);
	check(
		"session title derives from the Next Task (goal was null)",
		run.session.sessionInfo[0] === VALID_TITLE,
		String(run.session.sessionInfo[0]),
	);
}
check(
	"success notify names the title + generating model (no file path)",
	run.notes.some(
		(x) =>
			x.level === "info" &&
			x.message.includes(VALID_TITLE) &&
			x.message.includes("generated with stub-model"),
	),
	JSON.stringify(run.notes),
);
check(
	"completion emitted BEFORE newSession (stale-ctx tripwire held)",
	run.order.indexOf("emit:handoff_command_complete") !== -1 &&
		run.order.indexOf("emit:handoff_command_complete") <
			run.order.indexOf("newSession"),
	JSON.stringify(run.order),
);
check(
	"lifecycle pairing: exactly one start + one success complete",
	run.pi.emitted.filter((e) => e.ch === "handoff_command_start").length === 1 &&
		run.pi.emitted.filter((e) => e.ch === "handoff_command_complete").length ===
			1,
	JSON.stringify(run.pi.emitted.map((e) => e.ch)),
);

console.log("executor generation routing (registry-owned):");
{
	const c = run.registry.calls;
	check(
		"generation routed through ModelRegistry.complete exactly once",
		run.registry.calls.length === 1,
		String(c.length),
	);
	check(
		"registry called with the resolved handoff model (active-model fallback)",
		c[0]?.model?.id === "stub-model" && c[0]?.model?.provider === "stub",
		JSON.stringify(c[0]?.model),
	);
	check(
		"adapter does NOT hand-resolve auth — env/baseUrl inheritance stays with the runtime",
		run.registry.getApiKeyCalls === 0,
		String(run.registry.getApiKeyCalls),
	);
	check(
		"no auth fields forwarded (apiKey/headers/env left to runtime resolution)",
		c[0]?.options?.apiKey === undefined &&
			c[0]?.options?.headers === undefined &&
			c[0]?.options?.env === undefined,
		JSON.stringify(c[0]?.options),
	);
	check(
		"request context carries system prompt + one user payload message",
		c[0]?.context?.systemPrompt?.includes("context transfer assistant") ===
			true &&
			c[0]?.context?.messages?.length === 1 &&
			c[0]?.context?.messages?.[0]?.content?.[0]?.text?.includes(
				"## Conversation History",
			) === true,
		JSON.stringify(c[0]?.context)?.slice(0, 200),
	);
	check(
		"abort signal forwarded to the generation call",
		c[0]?.options?.signal instanceof AbortSignal &&
			c[0].options.signal.aborted === false,
		String(c[0]?.options?.signal),
	);
}

console.log("executor (missing ## Next Task): clipboard + stderr rescue (a):");
const runBad = await runExecutor(INVALID_DOC);
const completeBad = runBad.pi.emitted.find(
	(e) => e.ch === "handoff_command_complete",
);
check(
	"rescue notify: warning naming the defect + clipboard/stderr",
	runBad.notes.some(
		(x) =>
			x.level === "warning" &&
			x.message.includes("## Next Task") &&
			x.message.includes("clipboard"),
	),
	JSON.stringify(runBad.notes),
);
check(
	"raw generated text copied to the clipboard exactly once",
	runBad.clipboard.length === 1 && runBad.clipboard[0].input === INVALID_DOC,
	JSON.stringify(runBad.clipboard.map((c) => c.input?.slice(0, 40))),
);
check(
	"generated text printed to stderr with the rescue header",
	runBad.stderr.includes("HANDOFF TEXT") && runBad.stderr.includes(INVALID_DOC),
	JSON.stringify(runBad.stderr.slice(0, 120)),
);
check(
	"invalid doc → NO session creation, NO staging, NO editor",
	runBad.newSessionCalls === 0 &&
		runBad.editorTexts.length === 0 &&
		runBad.editorCalls === 0,
);
check(
	"invalid doc → error-tagged completion WITHOUT artifactPath",
	!!completeBad &&
		completeBad.payload.error?.includes("## Next Task") === true &&
		!("artifactPath" in completeBad.payload),
	JSON.stringify(completeBad?.payload),
);
check(
	"invalid doc → ZERO filesystem writes (old flow saved the doc; this one must not)",
	runBad.zeroWrites,
	runBad.zeroWritesDetail,
);
check(
	"invalid doc → pairing: one start, one error complete",
	runBad.pi.emitted.filter((e) => e.ch === "handoff_command_start").length ===
		1 &&
		runBad.pi.emitted.filter((e) => e.ch === "handoff_command_complete")
			.length === 1,
	JSON.stringify(runBad.pi.emitted.map((e) => e.ch)),
);

console.log("executor rescue (b): createHandoffSession throws:");
{
	const runThrow = await runExecutor(VALID_DOC, {
		newSessionBehavior: "throw",
	});
	check(
		"throw → rescue notify (warning + clipboard mention)",
		runThrow.notes.some(
			(x) => x.level === "warning" && x.message.includes("clipboard"),
		),
		JSON.stringify(runThrow.notes),
	);
	check(
		"throw → composed live message rescued to clipboard + stderr",
		runThrow.clipboard.length === 1 &&
			runThrow.clipboard[0].input?.includes(VALID_TASK) === true &&
			runThrow.clipboard[0].input?.includes(CANONICAL_PA) === true &&
			runThrow.clipboard[0].input?.startsWith("<!-- pi-handoff v") === true &&
			runThrow.stderr.includes("HANDOFF TEXT"),
		JSON.stringify({
			clip: runThrow.clipboard[0]?.input?.slice(0, 60),
			stderr: runThrow.stderr.slice(0, 80),
		}),
	);
	check(
		"throw → error-tagged complete carries the thrown message, no artifactPath",
		runThrow.pi.emitted.some(
			(e) =>
				e.ch === "handoff_command_complete" &&
				e.payload.error?.includes("newSession exploded") === true &&
				!("artifactPath" in e.payload),
		),
		JSON.stringify(
			runThrow.pi.emitted.filter((e) => e.ch === "handoff_command_complete"),
		),
	);
	check(
		"throw → pairing: one start + TWO completes (pre-replacement success + error)",
		runThrow.pi.emitted.filter((e) => e.ch === "handoff_command_start").length ===
			1 &&
			runThrow.pi.emitted.filter((e) => e.ch === "handoff_command_complete")
				.length === 2,
		JSON.stringify(runThrow.pi.emitted.map((e) => e.ch)),
	);
	check(
		"throw → ZERO filesystem writes",
		runThrow.zeroWrites,
		runThrow.zeroWritesDetail,
	);
}

console.log("executor rescue (c): newSession returns cancelled:");
{
	const runCancel = await runExecutor(VALID_DOC, {
		newSessionBehavior: "cancelled",
	});
	check(
		"cancelled → no live message seeded (no replacement happened)",
		runCancel.session.liveMessages.length === 0,
		JSON.stringify(runCancel.session.liveMessages),
	);
	check(
		"cancelled → rescue notify (warning + clipboard mention)",
		runCancel.notes.some(
			(x) => x.level === "warning" && x.message.includes("clipboard"),
		),
		JSON.stringify(runCancel.notes),
	);
	check(
		"cancelled → composed live message rescued to clipboard + stderr",
		runCancel.clipboard.length === 1 &&
			runCancel.clipboard[0].input?.includes(VALID_TASK) === true &&
			runCancel.clipboard[0].input?.endsWith(CANONICAL_PA) === true,
		JSON.stringify(runCancel.clipboard.map((c) => c.input?.slice(0, 60))),
	);
	check(
		"cancelled → error-tagged complete 'Session creation cancelled', no artifactPath",
		runCancel.pi.emitted.some(
			(e) =>
				e.ch === "handoff_command_complete" &&
				e.payload.error === "Session creation cancelled" &&
				!("artifactPath" in e.payload),
		),
	);
	check(
		"cancelled → post-cancel emit does NOT hit the stale tripwire (no replacement)",
		runCancel.pi.emitted.filter((e) => e.ch === "handoff_command_complete")
			.length === 2,
		JSON.stringify(runCancel.pi.emitted.map((e) => e.ch)),
	);
	check(
		"cancelled → ZERO filesystem writes",
		runCancel.zeroWrites,
		runCancel.zeroWritesDetail,
	);
}

console.log("executor generation cache retention + effort:");
{
	const runEffort = await runExecutor(VALID_DOC, {
		settings: { effort: "low" },
	});
	check(
		"cacheRetention 'none' on the generation call (one-shot detached call)",
		runEffort.registry.calls.every((c) => c.options.cacheRetention === "none"),
		JSON.stringify(runEffort.registry.calls.map((c) => c.options.cacheRetention)),
	);
	check(
		"reasoning level forwarded from settings.effort",
		runEffort.registry.calls[0]?.options?.reasoning === "low" &&
			runEffort.registry.calls[0]?.options?.reasoningEffort === "low",
		String(runEffort.registry.calls[0]?.options?.reasoning),
	);
	check(
		"onResponse coarse progress hook forwarded",
		typeof runEffort.registry.calls[0]?.options?.onResponse === "function",
	);
}

console.log(
	"executor model fallback loop (configured model fails → active model):",
);
{
	const runFallback = await runExecutor(VALID_DOC, {
		settings: { provider: "stub", model: "configured-model" },
		failModelIds: ["configured-model"],
	});
	const calls = runFallback.registry.calls;
	check(
		"configured model tried first, active model second",
		calls.length === 2 &&
			calls[0]?.model?.id === "configured-model" &&
			calls[1]?.model?.id === "stub-model",
		JSON.stringify(calls.map((c) => c.model?.id)),
	);
	check(
		"per-model failure surfaced as an error notify before the fallback",
		runFallback.notes.some(
			(x) => x.level === "error" && x.message.includes("configured-model"),
		),
		JSON.stringify(runFallback.notes),
	);
	check(
		"cacheRetention 'none' on BOTH fallback attempts",
		calls.every((c) => c.options.cacheRetention === "none"),
		JSON.stringify(calls.map((c) => c.options.cacheRetention)),
	);
	const completeFallback = runFallback.pi.emitted.find(
		(e) => e.ch === "handoff_command_complete",
	);
	check(
		"fallback still launches the session + emits a success completion (no artifactPath)",
		!!completeFallback &&
			!completeFallback.payload.error &&
			!("artifactPath" in completeFallback.payload) &&
			runFallback.newSessionCalls === 1,
		JSON.stringify(completeFallback?.payload),
	);
	check(
		"success notify names the fallback model that generated the doc",
		runFallback.notes.some(
			(x) => x.level === "info" && x.message.includes("generated with stub-model"),
		),
		JSON.stringify(runFallback.notes),
	);
}

console.log("executor payload document-files section:");
{
	const emptyPayload =
		run.registry.calls[0]?.context?.messages?.[0]?.content?.[0]?.text ?? "";
	check(
		"payload omits ## Document Files when the gathered list is empty",
		emptyPayload.includes("## Conversation History") &&
			!emptyPayload.includes("## Document Files"),
		JSON.stringify(emptyPayload.slice(-300)),
	);

	const docBranch = [
		{ id: "u0", type: "message", message: { role: "user", content: "start" } },
		{
			id: "a0",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						name: "write",
						arguments: { path: join(execCwd, "notes", "plan.md") },
					},
				],
			},
		},
	];
	const runDocs = await runExecutor(VALID_DOC, { branch: docBranch });
	const docsPayload =
		runDocs.registry.calls[0]?.context?.messages?.[0]?.content?.[0]?.text ?? "";
	check(
		"payload includes ## Document Files when the list is non-empty",
		docsPayload.includes("## Document Files"),
		JSON.stringify(docsPayload.slice(-500)),
	);
	check(
		"payload document rows carry path + provenance marker",
		docsPayload.includes(`- ${join(execCwd, "notes", "plan.md")} — in-session`),
		JSON.stringify(docsPayload.slice(-500)),
	);
}

// ── 4. continue command — bare recovery from the continue toolCall (D10) ──
console.log("continue command — bare recovery:");
{
	const p = makeMockPi();
	const agentRecovery = scratchDir("pih-recovery-");
	process.env.PI_CODING_AGENT_DIR = agentRecovery;
	handoffExtension(p.pi);

	// Two staging calls across two assistant messages (repair loop across
	// turns) — the NEWEST message's document must win. Raw VALID_DOC still
	// carries the model-authored trailing PA; /continue strips it at launch.
	const branch = [
		{
			id: "u1",
			type: "message",
			message: { role: "user", content: "hand off please" },
		},
		{
			id: "a1",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc1",
						name: "continue",
						arguments: { document: "# Old\n\n## Next Task\nOlder task." },
					},
				],
			},
		},
		{
			id: "a2",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Staging the handoff." },
					{
						type: "toolCall",
						id: "tc2",
						name: "continue",
						arguments: { document: VALID_DOC },
					},
				],
			},
		},
	];

	const { state, newSession } = makeSessionCapture();
	const order = state.order;
	p.pi.events.emit = (ch: string, payload: any) => {
		if (state.stale)
			throw new Error(
				"This extension ctx is stale after session replacement or reload.",
			);
		order.push(`emit:${ch}`);
		p.emitted.push({ ch, payload });
	};
	const before = zeroWritesSnapshot(agentRecovery, agentRecovery);
	const ctx = makeMockCtx({
		sessionBranch: branch,
		ui: { notify: () => {}, setEditorText: () => {} },
		newSession,
	});

	let threw = false;
	try {
		await p.commands.get("continue").handler("", ctx);
	} catch {
		threw = true;
	}

	check("handler survives replacement (no stale throw)", !threw);
	const live = state.liveMessages[0] ?? "";
	const firstLine = live.split("\n", 1)[0];
	const savedAt = firstLine.match(/ saved: (\S+) -->$/)?.[1];
	check(
		"live message first line is the provenance comment, machine-stamped at launch",
		firstLine ===
			`<!-- pi-handoff v${HANDOFF_TEMPLATE_VERSION} | session: /tmp/fake-session.jsonl | saved: ${savedAt} -->` &&
			savedAt !== undefined &&
			!Number.isNaN(Date.parse(savedAt)),
		JSON.stringify(live.slice(0, 120)),
	);
	check(
		"live message = provenance + PA-stripped document + canonical PA",
		live === continuationPrompt(firstLine, STRIPPED_DOC),
		JSON.stringify(live),
	);
	check(
		"model-authored PA variant does not ride along; canonical PA is last",
		!live.includes("model-authored variant") && live.endsWith(CANONICAL_PA),
	);
	check(
		"findNextTaskContent on the live message still extracts the task",
		findNextTaskContent(live) === VALID_TASK,
	);
	check(
		"exactly one visible user message in the new session",
		state.appended.filter((m) => m.role === "user").length === 0 &&
			state.liveMessages.length === 1,
		JSON.stringify({ appended: state.appended, live: state.liveMessages }),
	);
	check(
		"hidden handoff-origin entry carries details.document = provenance + stripped doc",
		state.appended.length === 1 &&
			state.appended[0].role === "custom" &&
			state.appended[0].customType === "handoff-origin" &&
			state.appended[0].display === false &&
			state.appended[0].details?.document === `${firstLine}\n\n${STRIPPED_DOC}`,
		JSON.stringify(state.appended[0]?.details?.document?.slice(0, 120)),
	);
	check(
		"origin entry drops docPath; profile/parentSession/goal/timestamp preserved (D8/D11)",
		!("docPath" in (state.appended[0].details ?? {})) &&
			state.appended[0].details?.profile === agentRecovery &&
			state.appended[0].details?.parentSession === "/tmp/fake-session.jsonl" &&
			state.appended[0].details?.goal === null &&
			typeof state.appended[0].details?.timestamp === "number" &&
			state.appended[0].details?.templateVersion === undefined,
		JSON.stringify(state.appended[0].details),
	);
	check(
		"session title derives from the Next Task",
		state.sessionInfo[0] === VALID_TITLE,
		String(state.sessionInfo[0]),
	);
	const completeTail = p.emitted.filter(
		(e) => e.ch === "handoff_command_complete",
	)[0];
	check(
		"complete carries the task-derived title (success)",
		completeTail?.payload.sessionTitle === VALID_TITLE &&
			completeTail?.payload.error === undefined,
		JSON.stringify(completeTail?.payload),
	);
	check(
		"complete emitted BEFORE the session-replacement boundary",
		order.indexOf("emit:handoff_command_complete") !== -1 &&
			order.indexOf("emit:handoff_command_complete") < order.indexOf("newSession"),
		JSON.stringify(order),
	);
	check(
		"command launch performs ZERO filesystem writes (agent dir + cwd + tmpdir)",
		(() => {
			const after = zeroWritesSnapshot(agentRecovery, agentRecovery);
			return JSON.stringify(before) === JSON.stringify(after);
		})(),
		snapshotDiff(before, zeroWritesSnapshot(agentRecovery, agentRecovery)),
	);

	// Repair loop WITHIN one assistant message: last matching call wins.
	const p2 = makeMockPi();
	handoffExtension(p2.pi);
	const sameMessageBranch = [
		{
			id: "a1",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc1",
						name: "continue",
						arguments: { document: INVALID_DOC },
					},
					{
						type: "toolCall",
						id: "tc2",
						name: "continue",
						arguments: { document: VALID_DOC },
					},
				],
			},
		},
	];
	const cap2 = makeSessionCapture();
	await p2.commands.get("continue").handler(
		"",
		makeMockCtx({
			sessionBranch: sameMessageBranch,
			newSession: cap2.newSession,
		}),
	);
	check(
		"repair-loop last-wins within one message (valid call recovered)",
		cap2.state.liveMessages[0]?.includes(VALID_TASK) === true,
		JSON.stringify(cap2.state.liveMessages),
	);

	// Newest-message-wins even when the newer call is invalid → clean error.
	const p3 = makeMockPi();
	handoffExtension(p3.pi);
	const newerInvalidBranch = [
		{
			id: "a1",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc1",
						name: "continue",
						arguments: { document: VALID_DOC },
					},
				],
			},
		},
		{
			id: "a2",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc2",
						name: "continue",
						arguments: { document: INVALID_DOC },
					},
				],
			},
		},
	];
	const notes3: Array<{ message: string; level?: string }> = [];
	const cap3 = makeSessionCapture();
	await p3.commands.get("continue").handler(
		"",
		makeMockCtx({
			sessionBranch: newerInvalidBranch,
			newSession: cap3.newSession,
			ui: {
				notify: (message: string, level?: string) =>
					notes3.push({ message, level }),
				setEditorText: () => {},
			},
		}),
	);
	check(
		"newest message wins even when invalid → error notify, no launch",
		notes3.some(
			(n) => n.level === "error" && n.message.includes("## Next Task"),
		) && cap3.state.liveMessages.length === 0,
		JSON.stringify({ notes: notes3, live: cap3.state.liveMessages }),
	);
	const completeBad = p3.emitted.filter(
		(e) => e.ch === "handoff_command_complete",
	)[0];
	check(
		"invalid recovered doc → error-tagged completion (start+complete paired)",
		p3.emitted[0]?.ch === "handoff_command_start" &&
			completeBad !== undefined &&
			!!completeBad.payload.error,
		JSON.stringify(p3.emitted.map((e) => e.ch)),
	);

	// Restart simulation: a FRESH extension instance + branch rebuilt from
	// scratch (as loaded from JSONL) still recovers the document.
	const p4 = makeMockPi();
	handoffExtension(p4.pi);
	const cap4 = makeSessionCapture();
	await p4.commands
		.get("continue")
		.handler(
			"",
			makeMockCtx({ sessionBranch: branch, newSession: cap4.newSession }),
		);
	check(
		"restart simulation (fresh instance, branch reloaded) → still recovers",
		cap4.state.liveMessages.length === 1 &&
			cap4.state.sessionInfo[0] === VALID_TITLE,
		JSON.stringify(cap4.state.liveMessages),
	);
}

// ── 4b. session_start origin notify (D8 lookup fix) ──
console.log("session_start origin notify (D8 lookup fix):");
{
	const p = makeMockPi();
	process.env.PI_CODING_AGENT_DIR = agentExec;
	handoffExtension(p.pi);
	const onSessionStart = p.apiOn.find(([e]) => e === "session_start")![1];
	check(
		"session_start handler registered",
		typeof onSessionStart === "function",
	);

	const notes: Array<{ message: string; level?: string }> = [];
	const originEntry = (details: unknown) => ({
		id: "o1",
		type: "message",
		parentId: null,
		timestamp: "2026-09-13T00:00:00.000Z",
		message: {
			role: "custom",
			customType: "handoff-origin",
			content: "Handed off from: /tmp/parent.jsonl",
			display: false,
			details,
			timestamp: 1,
		},
	});
	const ctxWith = (entries: unknown[]) =>
		makeMockCtx({
			sessionManager: {
				getBranch: () => [],
				getSessionFile: () => "/tmp/fake-session.jsonl",
				getLeafId: () => "leaf-1",
				getEntries: () => entries,
			},
			ui: {
				notify: (message: string, level?: string) => notes.push({ message, level }),
				setEditorText: () => {},
			},
		});

	await onSessionStart(
		{ reason: "new" },
		ctxWith([
			originEntry({
				parentSession: "/tmp/sessions/2026-09-13T10-22-33-abc-def.jsonl",
				goal: "Ship the redesign",
				timestamp: 1,
				document:
					"<!-- pi-handoff v2 | session: /tmp/parent.jsonl | saved: 2026-09-13T00:00:00.000Z -->\n\n# Handoff",
				profile: agentExec,
			}),
		]),
	);
	check(
		"corrected-shape origin entry → notify fires (lookup fix verified)",
		notes.length === 1 &&
			notes[0].level === "info" &&
			notes[0].message.startsWith("↩ Continued from previous session"),
		JSON.stringify(notes),
	);
	check(
		"notify carries goal hint + profile + parent session path tail",
		notes[0]?.message.includes("Ship the redesign") === true &&
			notes[0]?.message.includes(agentExec) === true &&
			notes[0]?.message.includes("2026-09-13T10-22-33-abc-def.jsonl") === true,
		notes[0]?.message,
	);

	notes.length = 0;
	await onSessionStart(
		{ reason: "new" },
		ctxWith([
			{
				id: "u1",
				type: "message",
				parentId: null,
				timestamp: "",
				message: { role: "user", content: "hello", timestamp: 1 },
			},
		]),
	);
	check(
		"origin-less session → no notify",
		notes.length === 0,
		JSON.stringify(notes),
	);

	notes.length = 0;
	await onSessionStart(
		{ reason: "new" },
		ctxWith([
			{
				id: "c1",
				type: "custom",
				parentId: null,
				timestamp: "",
				customType: "handoff-origin",
				data: {},
			},
		]),
	);
	check(
		"phantom custom-entry shape (never written by this extension) → no notify",
		notes.length === 0,
		JSON.stringify(notes),
	);

	notes.length = 0;
	await onSessionStart(
		{ reason: "resume" },
		ctxWith([originEntry({ profile: agentExec })]),
	);
	check("reason ≠ new → no notify", notes.length === 0, JSON.stringify(notes));

	notes.length = 0;
	await onSessionStart({ reason: "new" }, ctxWith([originEntry(undefined)]));
	check(
		"origin entry without details → base notify still fires",
		notes.length === 1 &&
			notes[0].message === "↩ Continued from previous session",
		JSON.stringify(notes),
	);
}

// ── 5. continue tool — document inline, staging, ZERO writes (D10) ──
console.log("continue tool:");
{
	const agentTool = scratchDir("pih-tool-");
	process.env.PI_CODING_AGENT_DIR = agentTool;
	const p = makeMockPi();
	handoffExtension(p.pi);
	const toolEditorTexts: string[] = [];
	const before = zeroWritesSnapshot(agentTool, agentTool);
	const toolCtx = makeMockCtx({
		cwd: agentTool,
		ui: {
			notify: () => {},
			setEditorText: (t: string) => toolEditorTexts.push(t),
		},
	});

	const ok = await p.tools
		.get("continue")
		.execute("t1", { document: VALID_DOC }, undefined, undefined, toolCtx);
	check("valid document → no isError", !ok.isError, JSON.stringify(ok));
	check(
		"editor staged with BARE /continue",
		toolEditorTexts.length === 1 && toolEditorTexts[0] === "/continue",
		String(toolEditorTexts),
	);
	check(
		"tui_filled_handoff emitted with { goal: title, command: '/continue' }",
		p.emitted.filter((e) => e.ch === "tui_filled_handoff").length === 1 &&
			p.emitted.some(
				(e) =>
					e.ch === "tui_filled_handoff" &&
					e.payload.command === "/continue" &&
					e.payload.goal === VALID_TITLE,
			),
		JSON.stringify(p.emitted),
	);
	const stagedLine: string = ok.details?.provenanceLine ?? "";
	const stagedAt = stagedLine.match(/ saved: (\S+) -->$/)?.[1];
	check(
		"details.provenanceLine = machine-stamped line (v-token + session file + ISO-8601)",
		stagedLine.startsWith(PROVENANCE_HEADER_PREFIX) &&
			stagedLine ===
				`<!-- pi-handoff v${HANDOFF_TEMPLATE_VERSION} | session: /tmp/fake-session.jsonl | saved: ${stagedAt} -->` &&
			stagedAt !== undefined &&
			!Number.isNaN(Date.parse(stagedAt)),
		JSON.stringify(stagedLine),
	);
	check(
		"details.document is the PA-stripped normalized body",
		ok.details?.document === STRIPPED_DOC &&
			!ok.details?.document.includes("## Phase Adherence"),
		JSON.stringify(ok.details?.document),
	);
	check(
		"details.suggestedCommand = bare /continue; title task-derived",
		ok.details?.suggestedCommand === "/continue" &&
			ok.details?.sessionTitle === VALID_TITLE,
		JSON.stringify(ok.details),
	);
	check(
		"success result tells the agent to STOP",
		ok.content[0].text.includes("Stop"),
	);
	check(
		"ZERO filesystem writes (agent dir + cwd + tmpdir scopes)",
		(() => {
			const after = zeroWritesSnapshot(agentTool, agentTool);
			return JSON.stringify(before) === JSON.stringify(after);
		})(),
		snapshotDiff(before, zeroWritesSnapshot(agentTool, agentTool)),
	);

	// Trailing-PA variants through the tool: paraphrased body stripped,
	// no-PA passthrough, non-trailing PA kept.
	const variantCtx = makeMockCtx({ cwd: agentTool });
	const runTool = (document: string) =>
		p.tools
			.get("continue")
			.execute("tv", { document }, undefined, undefined, variantCtx);
	const paraphrased = await runTool(
		`${PLAIN_DOC}\n\n## Phase Adherence\nauthored variant body`,
	);
	check(
		"paraphrased trailing PA stripped from details.document",
		paraphrased.details?.document === PLAIN_DOC,
		JSON.stringify(paraphrased.details?.document),
	);
	const noPa = await runTool(PLAIN_DOC);
	check(
		"document without trailing PA passes through byte-identical",
		noPa.details?.document === PLAIN_DOC,
	);
	const midPa = await runTool(
		`${PLAIN_DOC}\n\n## Phase Adherence\nv\n\n## Afterword\nkept`,
	);
	check(
		"non-trailing PA kept (strip only touches the final section)",
		midPa.details?.document ===
			`${PLAIN_DOC}\n\n## Phase Adherence\nv\n\n## Afterword\nkept`,
	);

	// Repair loop: invalid → isError naming the defect; absent/blank → isError.
	const fillEventsBefore = p.emitted.filter(
		(e) => e.ch === "tui_filled_handoff",
	).length;
	const bad = await runTool(INVALID_DOC);
	check("invalid document → isError", bad.isError === true);
	check(
		"repair hint mentions ## Next Task + fixing the DOCUMENT text",
		bad.content[0].text.includes("## Next Task") &&
			bad.content[0].text.includes("DOCUMENT"),
	);
	const absent = await p.tools
		.get("continue")
		.execute("t2", {} as any, undefined, undefined, variantCtx);
	check("absent document → isError", absent.isError === true);
	const blank = await runTool("   \n\t");
	check("blank document → isError", blank.isError === true);
	check(
		"failure paths stage nothing (fill-event count unchanged)",
		p.emitted.filter((e) => e.ch === "tui_filled_handoff").length ===
			fillEventsBefore,
		JSON.stringify(p.emitted.map((e) => e.ch)),
	);
}

// ── 6. /continue argument forms: missing doc, generic text, docPath-as-text ──
console.log("/continue argument forms:");
{
	// Bare with NO continue toolCall in the branch → clean error, no launch.
	const p = makeMockPi();
	const agentNoDoc = scratchDir("pih-nodoc-");
	process.env.PI_CODING_AGENT_DIR = agentNoDoc;
	handoffExtension(p.pi);
	const notes: string[] = [];
	const cap = makeSessionCapture();
	await p.commands.get("continue").handler(
		"",
		makeMockCtx({
			sessionBranch: [
				{ id: "u1", type: "message", message: { role: "user", content: "hello" } },
			],
			ui: { notify: (m: string) => notes.push(m), setEditorText: () => {} },
			newSession: cap.newSession,
		}),
	);
	check(
		"bare with no continue toolCall → clean error, no launch",
		notes.some((m) => m.includes("No handoff document in this session")) &&
			cap.state.liveMessages.length === 0,
		JSON.stringify(notes),
	);
	check(
		"no-document error emits no lifecycle events",
		p.emitted.filter(
			(e) =>
				e.ch === "handoff_command_start" || e.ch === "handoff_command_complete",
		).length === 0,
		JSON.stringify(p.emitted.map((e) => e.ch)),
	);

	// Generic text → as-is, nothing seeded.
	const p2 = makeMockPi();
	handoffExtension(p2.pi);
	const cap2 = makeSessionCapture();
	const genericText = "now implement the parser module";
	await p2.commands.get("continue").handler(
		genericText,
		makeMockCtx({
			ui: { notify: () => {}, setEditorText: () => {} },
			newSession: cap2.newSession,
		}),
	);
	check(
		"generic: live message is text as-is",
		cap2.state.liveMessages[0] === genericText,
		JSON.stringify(cap2.state.liveMessages),
	);
	check(
		"generic: no LLM-visible message seeded",
		!cap2.state.appended.some((m) => m.role === "user"),
		JSON.stringify(cap2.state.appended),
	);
	check(
		"generic: complete emitted with title",
		p2.emitted.some(
			(e) =>
				e.ch === "handoff_command_complete" &&
				e.payload.sessionTitle === deriveSessionTitle(null, genericText),
		),
	);

	// Old docPath habit: an argument that looks like a path is just text (D13).
	const p3 = makeMockPi();
	handoffExtension(p3.pi);
	const cap3 = makeSessionCapture();
	const pathArg = join(
		tmpdir(),
		"data",
		"pi-handoff",
		"handoff-2026-01-01T00-00-00-000Z.md",
	);
	await p3.commands.get("continue").handler(
		pathArg,
		makeMockCtx({
			ui: { notify: () => {}, setEditorText: () => {} },
			newSession: cap3.newSession,
		}),
	);
	check(
		"docPath argument → sent as generic text, no special-casing",
		cap3.state.liveMessages[0] === pathArg,
		JSON.stringify(cap3.state.liveMessages),
	);
	check(
		"docPath argument → generic title, no document in origin entry",
		cap3.state.appended.every((m) => m.role !== "user") &&
			cap3.state.appended[0]?.details?.document === undefined &&
			p3.emitted.some(
				(e) =>
					e.ch === "handoff_command_complete" &&
					e.payload.sessionTitle === deriveSessionTitle(null, pathArg),
			),
		JSON.stringify(cap3.state.appended),
	);
}

// ── 7. lifecycle pairing (bare recovery launch) ──
console.log("lifecycle pairing:");
{
	const p = makeMockPi();
	handoffExtension(p.pi);
	const branch = [
		{
			id: "a1",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc1",
						name: "continue",
						arguments: { document: VALID_DOC },
					},
				],
			},
		},
	];
	await p.commands.get("continue").handler(
		"",
		makeMockCtx({
			sessionBranch: branch,
			ui: { notify: () => {}, setEditorText: () => {} },
			newSession: makeSessionCapture().newSession,
		}),
	);
	const starts = p.emitted.filter((e) => e.ch === "handoff_command_start");
	const completes = p.emitted.filter((e) => e.ch === "handoff_command_complete");
	check(
		"bare recovery → exactly one start+complete pair, success-tagged",
		starts.length === 1 &&
			completes.length === 1 &&
			completes[0].payload.error === undefined &&
			completes[0].payload.sessionTitle === VALID_TITLE,
		JSON.stringify(p.emitted.map((e) => ({ ch: e.ch, payload: e.payload }))),
	);
}

// ── 8. document-file extraction (D4 allowlist/denylist + D5 union) ──
console.log("document-file extraction:");
{
	const DENY = ["/agent/tmp", "/agent/data/pi-handoff"];
	const gitCtx = {
		repos: [
			{
				workingDirectory: "/repo",
				path: ".",
				branch: "main",
				status: [
					"?? docs/new-dir/notes.md", // untracked FILE in a new dir (the --untracked-files=all row)
					" M README.md",
					"R  old/spec.txt -> new/spec.txt", // rename → NEW path
					'R  "old/caf\\303\\251.md" -> "new/plain.md"', // QUOTED rename (both sides C-quoted)
					'R  plain.md -> "new/caf\\303\\251.md"', // MIXED rename: plain left, quoted right
					'?? "caf\\303\\251-menu.md"', // C-quoted (caf\303\251 = é)
					"?? node_modules/pkg/readme.md", // denylist fragment
					" M src/index.ts", // non-document extension
					"?? scratch.log", // non-document extension
					" D dropped.md", // deleted → nothing to hand off
				].join("\n"),
				diffStat: "",
				recentCommits: "",
			},
		],
	};
	const branch = [
		{ id: "u1", type: "message", message: { role: "user", content: "go" } },
		{
			id: "a1",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Writing docs." },
					{
						type: "toolCall",
						name: "write",
						arguments: { path: "/repo/docs/plan.md" },
					},
					{ type: "toolCall", name: "edit", arguments: { path: "/repo/README.md" } },
					{
						type: "toolCall",
						name: "write",
						arguments: { path: "/outside/standalone.md" },
					},
					{
						type: "toolCall",
						name: "write",
						arguments: { path: "/agent/tmp/scratch.md" },
					},
					{
						type: "toolCall",
						name: "write",
						arguments: { path: "/agent/data/pi-handoff/handoff-x.md" },
					},
					{
						type: "toolCall",
						name: "read",
						arguments: { path: "/repo/other-notes.md" },
					},
					{ type: "toolCall", name: "bash", arguments: { command: "echo hi" } },
				],
			},
		},
	];
	const files: DocumentFile[] = extractDocumentFiles(
		gitCtx as any,
		// The extractor consumes AgentMessage[] (entry.message values) — the
		// same shape the gatherer passes from getHandoffMessages.
		branch.map((e: any) => e.message),
		DENY,
		"/wsp",
	);
	const find = (p: string) => files.find((f) => f.path === p);

	check(
		"untracked file inside a NEW dir yields the FILE (--untracked-files=all row)",
		find("/repo/docs/new-dir/notes.md")?.provenance === "git-only",
		JSON.stringify(files),
	);
	check(
		"rename row yields the NEW path only",
		find("/repo/new/spec.txt")?.provenance === "git-only" &&
			!find("/repo/old/spec.txt"),
		JSON.stringify(files),
	);
	check(
		"quoted rename (both sides) yields decoded NEW path",
		find("/repo/new/plain.md")?.provenance === "git-only" &&
			!find("/repo/old/caf\u00e9.md"),
		JSON.stringify(files),
	);
	check(
		"mixed rename (plain -> quoted right) yields decoded NEW path",
		find("/repo/new/caf\u00e9.md")?.provenance === "git-only" &&
			!find("/repo/plain.md"),
		JSON.stringify(files),
	);
	check(
		"C-quoted path is unquoted",
		find("/repo/café-menu.md")?.provenance === "git-only" &&
			!find('/repo/"caf\\303\\251-menu.md"'),
		JSON.stringify(files),
	);
	check(
		"denylist fragments excluded (node_modules)",
		!files.some((f) => f.path.includes("node_modules")),
		JSON.stringify(files),
	);
	check(
		"non-document extensions excluded",
		!find("/repo/src/index.ts") && !find("/repo/scratch.log"),
		JSON.stringify(files),
	);
	check(
		"deleted rows excluded (no file left to hand off)",
		!find("/repo/dropped.md"),
		JSON.stringify(files),
	);
	check(
		"in-session provenance from write/edit tool calls; reads ignored",
		find("/repo/docs/plan.md")?.provenance === "in-session" &&
			find("/outside/standalone.md")?.provenance === "in-session" &&
			!find("/repo/other-notes.md"),
		JSON.stringify(files),
	);
	check(
		"agent-dir tmp + data/pi-handoff denied",
		!find("/agent/tmp/scratch.md") &&
			!find("/agent/data/pi-handoff/handoff-x.md"),
		JSON.stringify(files),
	);
	check(
		"dedupe: in-session wins over git-only when both sources hit",
		JSON.stringify(files.filter((f) => f.path === "/repo/README.md")) ===
			JSON.stringify([{ path: "/repo/README.md", provenance: "in-session" }]),
		JSON.stringify(files),
	);
	check(
		"order: in-session rows first, alphabetical within each group",
		JSON.stringify(files.map((f) => `${f.path} ${f.provenance}`)) ===
			JSON.stringify([
				"/outside/standalone.md in-session",
				"/repo/README.md in-session",
				"/repo/docs/plan.md in-session",
				"/repo/café-menu.md git-only",
				"/repo/docs/new-dir/notes.md git-only",
				"/repo/new/café.md git-only",
				"/repo/new/plain.md git-only",
				"/repo/new/spec.txt git-only",
			]),
		JSON.stringify(files),
	);

	check(
		"deny dirs resolve from the agent dir",
		(() => {
			process.env.PI_CODING_AGENT_DIR = "/agent";
			return (
				JSON.stringify(documentDenyDirs()) ===
				JSON.stringify(["/agent/tmp", "/agent/data/pi-handoff"])
			);
		})(),
		JSON.stringify(documentDenyDirs()),
	);

	// Live git: the status exec must be uncollapsed — a file inside an
	// untracked directory must arrive as its own row (the old `?? dir/`
	// collapse would hide it from extraction entirely).
	const liveRepo = mkdtempSync(join(tmpdir(), "pih-gitrepo-"));
	scratchDirs.push(liveRepo);
	execSync("git init -q", { cwd: liveRepo });
	execSync(
		"git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init",
		{
			cwd: liveRepo,
		},
	);
	mkdirSync(join(liveRepo, "fresh-dir"), { recursive: true });
	writeFileSync(join(liveRepo, "fresh-dir", "idea.md"), "note");
	writeFileSync(join(liveRepo, "code.ts"), "export {};");
	// git resolves the toplevel through symlinks (macOS /var → /private/var)
	const realRepo = realpathSync(liveRepo);
	const liveGit = getGitContext(liveRepo);
	const liveStatus: string = liveGit?.repos[0]?.status ?? "";
	const liveFiles: DocumentFile[] = extractDocumentFiles(
		liveGit,
		[],
		documentDenyDirs(),
		liveRepo,
	);
	check(
		"live git status lists the file inside the untracked dir (no ?? dir/ collapse)",
		liveStatus
			.split("\n")
			.some((l) => l.endsWith(join("fresh-dir", "idea.md"))) &&
			!liveStatus.split("\n").includes("?? fresh-dir/"),
		JSON.stringify(liveStatus),
	);
	check(
		"live extraction yields the new-dir document as git-only, code filtered",
		liveFiles.some(
			(f) =>
				f.path === join(realRepo, "fresh-dir", "idea.md") &&
				f.provenance === "git-only",
		) && !liveFiles.some((f) => f.path === join(realRepo, "code.ts")),
		JSON.stringify(liveFiles),
	);
}

// ── 9. handoff.skipTools — pre-serialization stub filter (D9) ──
console.log("skipTools pre-serialization filter (D9):");
{
	const { DEFAULT_SKIP_TOOLS, applySkipToolFilter } = await import(
		join(repo, "infrastructure/tool-skip.ts")
	);
	const { buildConversationText, buildHandoffContext, extractTodos } =
		await import(join(repo, "infrastructure/session-adapter.ts"));

	const toolCall = (
		id: string,
		name: string,
		args: Record<string, unknown> = {},
	) => ({ type: "toolCall", id, name, arguments: args });
	const toolResultMsg = (
		toolCallId: string,
		toolName: string,
		text: string,
		details?: unknown,
	) => ({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		...(details === undefined ? {} : { details }),
		isError: false,
		timestamp: 1,
	});
	const entry = (id: string, message: unknown) => ({
		id,
		type: "message",
		message,
	});
	type Note = { message: string; level?: string };
	const skipCtx = (branch: unknown[], notes: Note[]) =>
		makeMockCtx({
			sessionBranch: branch,
			ui: {
				notify: (message: string, level?: string) => notes.push({ message, level }),
				setEditorText: () => {},
			},
		});

	check(
		"DEFAULT_SKIP_TOOLS = the five documented patterns (incl. continue, D11)",
		JSON.stringify([...DEFAULT_SKIP_TOOLS]) ===
			JSON.stringify([
				"*mempalace_diary_write",
				"*mempalace_reconnect",
				"jira_assign_ticket",
				"jira_update_status",
				"continue",
			]),
		JSON.stringify([...DEFAULT_SKIP_TOOLS]),
	);
	check(
		"document-bearing continue toolCall collapses in serialization",
		(() => {
			const continueBranch = [
				entry("k0", { role: "user", content: "hand off" }),
				entry("k1", {
					role: "assistant",
					content: [
						{ type: "text", text: "KEEP-STAGED-NARRATION" },
						toolCall("kc1", "continue", { document: "SECRET-DOC-BODY" }),
					],
				}),
				entry("k2", toolResultMsg("kc1", "continue", "HANDOFF-STAGED")),
			];
			const out = buildConversationText(skipCtx(continueBranch, []));
			return (
				!out.includes("SECRET-DOC-BODY") &&
				!out.includes("HANDOFF-STAGED") &&
				out.includes("[skipped by handoff.skipTools: continue]") &&
				out.includes("KEEP-STAGED-NARRATION")
			);
		})(),
	);

	// NIT (W1 review): the harness convertToLlm stub must mirror upstream's
	// custom→user mapping (identity stub masked the Issue-2 leak class) —
	// a custom-role message serializes as a USER message carrying its content,
	// while `details` (e.g. the handoff-origin document) never serializes.
	const customOut = buildConversationText(
		skipCtx(
			[
				entry("x1", {
					role: "custom",
					customType: "handoff-origin",
					content: "CUSTOM-CONTENT-CANARY",
					display: false,
					details: { document: "DETAILS-NEVER-SERIALIZED" },
					timestamp: 1,
				}),
			],
			[],
		),
	);
	check(
		"custom-role message renders as [User]: with its content (custom→user mapping)",
		customOut.includes("[User]: CUSTOM-CONTENT-CANARY"),
		JSON.stringify(customOut),
	);
	check(
		"custom details never serialize (no document duplication into LLM requests)",
		!customOut.includes("DETAILS-NEVER-SERIALIZED") &&
			!customOut.includes("handoff-origin"),
		JSON.stringify(customOut),
	);

	// Default matrix — defaults active with NO config present (default ON).
	const skipDefaultDir = scratchDir("pih-skip-default-");
	process.env.PI_CODING_AGENT_DIR = skipDefaultDir;

	const matrixBranch = [
		entry("m0", { role: "user", content: "log the session" }),
		entry("m1", {
			role: "assistant",
			content: [
				{ type: "text", text: "Recording." },
				toolCall("c1", "mempalace_diary_write", {
					content: "PLAIN-DIARY-BODY",
				}),
				toolCall("c2", "mempalace-personal_mempalace_diary_write", {
					content: "PREFIXED-DIARY-BODY",
				}),
				toolCall("c3", "read", { path: "/tmp/notes.md" }),
			],
		}),
		entry(
			"m2",
			toolResultMsg("c1", "mempalace_diary_write", "PLAIN-DIARY-SAVED"),
		),
		entry(
			"m3",
			toolResultMsg(
				"c2",
				"mempalace-personal_mempalace_diary_write",
				"PREFIXED-DIARY-SAVED",
			),
		),
		entry("m4", toolResultMsg("c3", "read", "VERBATIM-READ-RESULT")),
		entry("m5", {
			role: "assistant",
			content: [
				toolCall("c4", "mempalace_reconnect"),
				toolCall("c5", "jira_assign_ticket", { ticket: "T-1" }),
				toolCall("c6", "jira_update_status", { ticket: "T-1" }),
			],
		}),
		entry("m6", toolResultMsg("c4", "mempalace_reconnect", "RECONNECTED")),
		entry("m7", toolResultMsg("c5", "jira_assign_ticket", "ASSIGNED")),
		entry("m8", toolResultMsg("c6", "jira_update_status", "UPDATED")),
		entry("m9", {
			role: "assistant",
			content: [
				toolCall("c7", "mempalace-personal_mempalace_search", {
					query: "handoff",
				}),
			],
		}),
		entry(
			"m10",
			toolResultMsg(
				"c7",
				"mempalace-personal_mempalace_search",
				"VERBATIM-SEARCH-HITS",
			),
		),
		entry("m11", {
			role: "assistant",
			content: [toolCall("c8", "jira_read_ticket", { ticket: "T-2" })],
		}),
		entry("m12", toolResultMsg("c8", "jira_read_ticket", "VERBATIM-JIRA-READ")),
		entry("m13", {
			role: "assistant",
			content: [toolCall("c9", "bash", { command: "ls" })],
		}),
		entry("m14", toolResultMsg("c9", "bash", "VERBATIM-BASH-OUT")),
		entry("m15", {
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
		}),
	];

	const matrixNotes: Note[] = [];
	const matrixOut = buildConversationText(skipCtx(matrixBranch, matrixNotes));

	check(
		"plain mempalace_diary_write → call args gone + one-line result stub",
		!matrixOut.includes("PLAIN-DIARY-BODY") &&
			!matrixOut.includes("PLAIN-DIARY-SAVED") &&
			matrixOut.includes("[skipped by handoff.skipTools: mempalace_diary_write]"),
		JSON.stringify(matrixOut),
	);
	check(
		"server-prefixed mempalace-personal_mempalace_diary_write → same stub",
		!matrixOut.includes("PREFIXED-DIARY-BODY") &&
			!matrixOut.includes("PREFIXED-DIARY-SAVED") &&
			matrixOut.includes(
				"[skipped by handoff.skipTools: mempalace-personal_mempalace_diary_write]",
			),
		JSON.stringify(matrixOut),
	);
	check(
		"mempalace_reconnect → stubbed (call dropped + result stubbed)",
		!matrixOut.includes("RECONNECTED") &&
			matrixOut.includes("[skipped by handoff.skipTools: mempalace_reconnect]"),
		JSON.stringify(matrixOut),
	);
	check(
		"jira_assign_ticket + jira_update_status → stubbed",
		!matrixOut.includes("ASSIGNED") &&
			!matrixOut.includes("UPDATED") &&
			matrixOut.includes("[skipped by handoff.skipTools: jira_assign_ticket]") &&
			matrixOut.includes("[skipped by handoff.skipTools: jira_update_status]"),
		JSON.stringify(matrixOut),
	);
	check(
		"non-matching read (server-prefixed search) → result verbatim, call kept",
		matrixOut.includes("VERBATIM-SEARCH-HITS") &&
			matrixOut.includes(
				"[Assistant tool calls]: mempalace-personal_mempalace_search",
			),
		JSON.stringify(matrixOut),
	);
	check(
		"non-matching reads (jira_read_ticket, plain read/bash) → fully intact",
		matrixOut.includes("VERBATIM-JIRA-READ") &&
			matrixOut.includes("VERBATIM-READ-RESULT") &&
			matrixOut.includes("VERBATIM-BASH-OUT"),
		JSON.stringify(matrixOut),
	);
	check(
		"kept toolCall block still serializes (read listed with args)",
		matrixOut.includes('read(path="/tmp/notes.md")'),
		JSON.stringify(matrixOut),
	);
	check(
		"assistant narration survives (only toolCall blocks dropped)",
		matrixOut.includes("Recording.") && matrixOut.includes("Done."),
		JSON.stringify(matrixOut),
	);
	check(
		"valid defaults/absent config → no notify",
		matrixNotes.length === 0,
		JSON.stringify(matrixNotes),
	);

	// Override replaces: a configured list REPLACES the defaults.
	const overrideBranch = [
		entry("o0", { role: "user", content: "go" }),
		entry("o1", {
			role: "assistant",
			content: [
				toolCall("oc1", "mempalace_diary_write", {
					content: "OVERRIDE-DIARY",
				}),
			],
		}),
		entry(
			"o2",
			toolResultMsg("oc1", "mempalace_diary_write", "OVERRIDE-DIARY-SAVED"),
		),
		entry("o3", {
			role: "assistant",
			content: [toolCall("oc2", "foo_bar", { x: 1 })],
		}),
		entry("o4", toolResultMsg("oc2", "foo_bar", "OVERRIDE-FOOBAR-SAVED")),
	];

	process.env.PI_CODING_AGENT_DIR = scratchDir("pih-skip-override-", {
		handoff: { skipTools: ["foo_*"] },
	});
	const overrideNotes: Note[] = [];
	const overrideOut = buildConversationText(
		skipCtx(overrideBranch, overrideNotes),
	);
	check(
		"user list REPLACES defaults (mempalace NOT stubbed)",
		overrideOut.includes("OVERRIDE-DIARY-SAVED") &&
			!overrideOut.includes(
				"[skipped by handoff.skipTools: mempalace_diary_write]",
			),
		JSON.stringify(overrideOut),
	);
	check(
		"override pattern foo_* → foo_bar call dropped + result stubbed",
		!overrideOut.includes("x=1") &&
			!overrideOut.includes("OVERRIDE-FOOBAR-SAVED") &&
			overrideOut.includes("[skipped by handoff.skipTools: foo_bar]"),
		JSON.stringify(overrideOut),
	);

	process.env.PI_CODING_AGENT_DIR = scratchDir("pih-skip-empty-", {
		handoff: { skipTools: [] },
	});
	const emptyNotes: Note[] = [];
	const emptyOut = buildConversationText(skipCtx(overrideBranch, emptyNotes));
	check(
		"[] disables filtering entirely (nothing stubbed)",
		emptyOut.includes("OVERRIDE-DIARY-SAVED") &&
			emptyOut.includes("OVERRIDE-FOOBAR-SAVED") &&
			!emptyOut.includes("[skipped by handoff.skipTools"),
		JSON.stringify(emptyOut),
	);
	check("[] → no notify", emptyNotes.length === 0, JSON.stringify(emptyNotes));

	// Malformed values: ignored entirely + one-line warning notify.
	for (const mc of [
		{ label: 'string "*diary" (not an array)', value: "*diary" as unknown },
		{ label: '["ok", 42] (non-string entry)', value: ["ok", 42] as unknown },
	]) {
		process.env.PI_CODING_AGENT_DIR = scratchDir("pih-skip-bad-", {
			handoff: { skipTools: mc.value },
		});
		const badNotes: Note[] = [];
		const badOut = buildConversationText(skipCtx(overrideBranch, badNotes));
		check(
			`malformed ${mc.label} → ignored, defaults active`,
			badOut.includes("[skipped by handoff.skipTools: mempalace_diary_write]") &&
				!badOut.includes("OVERRIDE-DIARY-SAVED"),
			JSON.stringify(badOut),
		);
		check(
			`malformed ${mc.label} → exactly one warning notify naming the key`,
			badNotes.length === 1 &&
				badNotes[0].level === "warning" &&
				badNotes[0].message.includes("skipTools"),
			JSON.stringify(badNotes),
		);
	}

	// Metachar literals in tool names are matched literally (regex-escaped,
	// no injection, no accidental pattern semantics).
	process.env.PI_CODING_AGENT_DIR = scratchDir("pih-skip-meta-", {
		handoff: { skipTools: ["weird+name(1)"] },
	});
	{
		const metaNotes: Note[] = [];
		const metaOut = buildConversationText(
			skipCtx(
				[
					entry("m1", {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tc1",
								name: "weird+name(1)",
								arguments: { x: 1 },
							},
							{ type: "text", text: "KEEP-NARRATION" },
						],
					}),
					entry("m2", {
						role: "toolResult",
						toolCallId: "tc1",
						toolName: "weird+name(1)",
						content: [{ type: "text", text: "META-RESULT" }],
					}),
				],
				metaNotes,
			),
		);
		check(
			"metachar literals (+, parens) matched literally — stubbed, narration kept",
			metaOut.includes("[skipped by handoff.skipTools: weird+name(1)]") &&
				!metaOut.includes("META-RESULT") &&
				!metaOut.includes("weird+name(1)({") &&
				metaOut.includes("KEEP-NARRATION"),
			JSON.stringify(metaOut),
		);
	}

	// Turn-order coherence: the stub line keeps the turn boundary legible.
	process.env.PI_CODING_AGENT_DIR = skipDefaultDir;
	const turnBranch = [
		entry("u1", { role: "user", content: "TURN-USER-1" }),
		entry("a1", {
			role: "assistant",
			content: [
				toolCall("tc1", "mempalace_diary_write", { content: "TURN-DIARY" }),
			],
		}),
		entry(
			"t1",
			toolResultMsg("tc1", "mempalace_diary_write", "TURN-DIARY-SAVED"),
		),
		entry("a2", {
			role: "assistant",
			content: [{ type: "text", text: "TURN-ASSISTANT-TEXT" }],
		}),
		entry("t2", toolResultMsg("tx", "read", "TURN-NEIGHBOR-READ")),
		entry("u2", { role: "user", content: "TURN-USER-2" }),
	];
	const turnOut = buildConversationText(skipCtx(turnBranch, []));
	const idx = (needle: string) => turnOut.indexOf(needle);
	check(
		"turn order: user1 < stub < assistant text < neighbor read < user2",
		idx("[User]: TURN-USER-1") !== -1 &&
			idx("[User]: TURN-USER-1") <
				idx("[skipped by handoff.skipTools: mempalace_diary_write]") &&
			idx("[skipped by handoff.skipTools: mempalace_diary_write]") <
				idx("[Assistant]: TURN-ASSISTANT-TEXT") &&
			idx("[Assistant]: TURN-ASSISTANT-TEXT") <
				idx("[Tool result]: TURN-NEIGHBOR-READ") &&
			idx("[Tool result]: TURN-NEIGHBOR-READ") < idx("[User]: TURN-USER-2"),
		JSON.stringify(turnOut),
	);
	check(
		"non-matching neighbor result keeps its content",
		turnOut.includes("[Tool result]: TURN-NEIGHBOR-READ"),
		JSON.stringify(turnOut),
	);

	// No-mutation: buildConversationText twice on the same live ctx/branch.
	const mutationBranch = [
		entry("n0", {
			role: "user",
			content:
				"[handoff preflight] A session handoff is starting. Consider a diary entry.",
		}),
		entry("n1", {
			role: "assistant",
			content: [
				toolCall("nc1", "mempalace_diary_write", {
					content: "NO-MUTATION-DIARY",
				}),
			],
		}),
		entry(
			"n2",
			toolResultMsg("nc1", "mempalace_diary_write", "NO-MUTATION-SAVED"),
		),
	];
	const mutCtx = skipCtx(mutationBranch, []);
	const branchSnapshot = JSON.stringify(mutationBranch);
	const mutOut1 = buildConversationText(mutCtx);
	const mutOut2 = buildConversationText(mutCtx);
	check("double run → identical output both times", mutOut1 === mutOut2);
	check(
		"double run → original branch objects unchanged (deep-compare vs snapshot)",
		JSON.stringify(mutationBranch) === branchSnapshot,
	);
	check(
		"defaults active during the double run (stub present)",
		mutOut1.includes("[skipped by handoff.skipTools: mempalace_diary_write]"),
		JSON.stringify(mutOut1),
	);
	check(
		"diary-reminder nudge (user message) survives — user messages never dropped",
		mutOut1.includes("[handoff preflight] A session handoff is starting."),
		JSON.stringify(mutOut1),
	);

	// User pattern matching `todo`: content stubbed, details INTACT — todo
	// extraction reads the ORIGINAL branch and must keep working.
	process.env.PI_CODING_AGENT_DIR = scratchDir("pih-skip-todo-", {
		handoff: { skipTools: ["todo"] },
	});
	const todoDetails = {
		todos: [{ id: 1, text: "Ship it", done: false }],
		nextId: 2,
	};
	const todoBranch = [
		entry("d0", { role: "user", content: "track work" }),
		entry("d1", { role: "assistant", content: [toolCall("dc1", "todo")] }),
		entry("d2", toolResultMsg("dc1", "todo", "TODO-CONTENT-TEXT", todoDetails)),
	];
	const todoOut = buildConversationText(skipCtx(todoBranch, []));
	check(
		'user pattern ["todo"] → stubbed content in serialized text',
		todoOut.includes("[skipped by handoff.skipTools: todo]") &&
			!todoOut.includes("TODO-CONTENT-TEXT"),
		JSON.stringify(todoOut),
	);
	check(
		"extractTodos on the SAME branch still returns the list (branch never filtered)",
		extractTodos(todoBranch as any) === "- [ ] Ship it",
		String(extractTodos(todoBranch as any)),
	);
	const clonedResult: any = applySkipToolFilter(
		todoBranch.map((e: any) => e.message),
	).find((m: any) => m.role === "toolResult");
	check(
		"filtered clone is a COPY with details intact (content-only mutation)",
		clonedResult !== todoBranch[2].message &&
			JSON.stringify(clonedResult.details) === JSON.stringify(todoDetails) &&
			JSON.stringify(clonedResult.content) ===
				JSON.stringify([
					{ type: "text", text: "[skipped by handoff.skipTools: todo]" },
				]),
		JSON.stringify(clonedResult),
	);

	// Wiring is real end-to-end: the gatherer payload carries the stubs.
	process.env.PI_CODING_AGENT_DIR = skipDefaultDir;
	const gatherCtx = skipCtx(matrixBranch, []);
	const gathered = buildHandoffContext(gatherCtx);
	check(
		"gatherer payload conversationText carries the stubs (filter wired end-to-end)",
		gathered.conversationText.includes(
			"[skipped by handoff.skipTools: mempalace_diary_write]",
		) && gathered.conversationText === buildConversationText(gatherCtx),
		JSON.stringify(gathered.conversationText.slice(0, 200)),
	);
	check(
		"gatherer messageCount counts the branch pre-filter; todos input untouched",
		gathered.messageCount === matrixBranch.length && gathered.todos === null,
		JSON.stringify({
			messageCount: gathered.messageCount,
			todos: gathered.todos,
		}),
	);
}

console.log(
	failures === 0 ? "\nALL SMOKE CHECKS PASSED" : `\n${failures} FAILURES`,
);
process.exit(failures === 0 ? 0 : 1);
