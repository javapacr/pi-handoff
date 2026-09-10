/**
 * Load + behavioral smoke for pi-handoff (unified flow: /handoff → /continue
 * → new session). Run: npm test (from the repo root).
 *
 * Self-staging: the repo package.json has no "type": "module" (tsx would
 * transform the extension as CJS and its require-hook bypasses ESM module
 * hooks), and the repo devDep versions of @earendil-works/* drift from pi's
 * runtime aliases. So we copy the repo's .ts tree into a temp ESM context,
 * register module hooks that stub those packages (plus the LLM adapter, see
 * hooks.mjs / stub-llm-client.mjs), and import the staged index.ts.
 *
 * Every scratch dir lives under os.tmpdir() and PI_CODING_AGENT_DIR is
 * repointed per block — the real ~/.pi is never touched.
 */
import {
	cpSync,
	mkdtempSync,
	writeFileSync,
	mkdirSync,
	statSync,
	existsSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
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
const { findNextTaskContent, buildContinuationPrompt, deriveSessionTitle } =
	await import(join(repo, "domain/handoff-prompt.ts"));
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
function continuationPrompt(docPath: string, task: string): string {
	return (
		`Handoff document: ${docPath}\n` +
		`Read it with the read tool before acting.\n\n` +
		`${task}\n\n` +
		`${CANONICAL_PA}`
	);
}

const VALID_DOC =
	"# Handoff\n\n## Context\nDid stuff.\n\n## Next Task\nShip the redesign.\n\n## Phase Adherence\nmodel-authored variant";
const INVALID_DOC =
	"# Handoff\n\n## Context\nNo `## Next Task` section at all.";
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

function writeDoc(agentDir: string, name: string, body: string): string {
	const dir = join(agentDir, "data", "pi-handoff");
	mkdirSync(dir, { recursive: true });
	const docPath = join(dir, name);
	writeFileSync(docPath, body);
	return docPath;
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
		sendUserMessage: (content: string, opts: any) => {},
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
	const mock = {
		mode: "tui",
		cwd: tmpdir(),
		model: { id: "stub-model", provider: "stub" },
		modelRegistry: { getAvailable: () => [], find: () => undefined },
		ui: {
			notify: () => {},
			setEditorText: (t: string) => mock.editorTexts.push(t),
		},
		getSystemPromptOptions: () => ({}),
		getContextUsage: () => undefined,
		sessionManager: {
			getBranch: () => [
				{ id: "e1", type: "message", message: { role: "user", content: "hello" } },
			],
			getSessionFile: () => "/tmp/fake-session.jsonl",
			getLeafId: () => "leaf-1",
		},
		...over,
	} as any;
	return mock;
}

/** Captures what a mocked `ctx.newSession` is asked to seed. */
function makeSessionCapture() {
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
	"continuation prompt = doc path + read-first + task + canonical PA",
	buildContinuationPrompt(
		"## Next Task\nDo the thing.\n\n## Phase Adherence\nmodel variant",
		"/tmp/doc.md",
	) === continuationPrompt("/tmp/doc.md", "Do the thing."),
);
check(
	"invalid doc → continuation null",
	buildContinuationPrompt("## Context\nx", "/tmp/doc.md") === null,
);
check(
	"title derives from Next Task first line",
	deriveSessionTitle(null, "Do the thing.\nmore detail") === "Do the thing.",
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
	"type=in-session → request_handoff tool registered",
	s.tools.has("request_handoff"),
);
check("type=in-session → continue tool registered", s.tools.has("continue"));
check(
	"all four surfaces register in the documented order",
	JSON.stringify(s.registrations) ===
		JSON.stringify([
			"command:handoff",
			"tool:request_handoff",
			"command:continue",
			"tool:continue",
		]),
	String(s.registrations),
);
check(
	"event hooks + bus listeners registered",
	s.apiOn.length === 2 && s.eventsOn.length === 2,
	JSON.stringify({ apiOn: s.apiOn.length, eventsOn: s.eventsOn.length }),
);

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
	"no settings.json → all four surfaces present",
	n.commands.has("handoff") &&
		n.commands.has("continue") &&
		n.tools.has("request_handoff") &&
		n.tools.has("continue"),
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
	newSessionCalls: number;
	editorCalls: number;
}

/** Drive executeHandoff end-to-end with a canned generated document. */
async function runExecutor(doc: string): Promise<ExecutorRun> {
	const p = makeMockPi();
	const notes: Array<{ message: string; level: string | undefined }> = [];
	const editorTexts: string[] = [];
	const order: string[] = [];
	let confirmCalls = 0;
	let compactCalls = 0;
	let newSessionCalls = 0;
	let editorCalls = 0;

	p.pi.events.emit = (ch: string, payload: any) => {
		order.push(`emit:${ch}`);
		p.emitted.push({ ch, payload });
	};

	const ctx = makeMockCtx({
		cwd: execCwd,
		compact: async () => {
			compactCalls++;
		},
		newSession: async () => {
			newSessionCalls++;
			return { cancelled: false };
		},
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

	// The stubbed LLM adapter (hooks.mjs → stub-llm-client.mjs) returns this.
	process.env.PIH_SMOKE_HANDOFF_DOC = doc;
	await executeHandoff(
		p.pi,
		ctx,
		{ rawArgs: "" },
		{ diaryReminder: false, terminal: "tmux" },
	);
	delete process.env.PIH_SMOKE_HANDOFF_DOC;

	return {
		pi: p,
		notes,
		editorTexts,
		order,
		confirmCalls,
		compactCalls,
		newSessionCalls,
		editorCalls,
	};
}

console.log("executor (valid doc):");
const run = await runExecutor(VALID_DOC);
const complete = run.pi.emitted.find(
	(e) => e.ch === "handoff_command_complete",
);
const artifactPath: string = complete?.payload.artifactPath;
check("completion emitted", complete !== undefined);
check(
	"doc saved under the handoff data dir (not tmpdir root)",
	typeof artifactPath === "string" &&
		dirname(artifactPath) === join(agentExec, "data", "pi-handoff") &&
		dirname(artifactPath) !== tmpdir() &&
		artifactPath.endsWith(".md") &&
		basename(artifactPath).startsWith("handoff-"),
	String(artifactPath),
);
check(
	"saved doc exists with the generated content",
	existsSync(artifactPath) && readFileSync(artifactPath, "utf8") === VALID_DOC,
);
check("no ui.confirm call (compaction gate removed)", run.confirmCalls === 0);
check("no ctx.compact call", run.compactCalls === 0);
check("editor review still runs (detached prompt path)", run.editorCalls === 1);
check(
	"completion is success-tagged with title + artifact path",
	!!complete &&
		complete.payload.error === undefined &&
		complete.payload.sessionTitle === VALID_TITLE &&
		complete.payload.artifactPath === artifactPath,
	JSON.stringify(complete?.payload),
);
check(
	"success notify names the saved doc",
	run.notes.some((x) => x.level === "info" && x.message.includes(artifactPath)),
	JSON.stringify(run.notes),
);
check(
	"editor staged with /continue <docPath>",
	run.editorTexts.length === 1 &&
		run.editorTexts[0] === `/continue ${artifactPath}`,
	JSON.stringify(run.editorTexts),
);
const filled = run.pi.emitted.find((e) => e.ch === "tui_filled_handoff");
check(
	"tui_filled_handoff emitted with { goal: sessionTitle, command }",
	filled !== undefined &&
		filled.payload.command === `/continue ${artifactPath}` &&
		filled.payload.goal === VALID_TITLE &&
		filled.payload.goal === complete?.payload.sessionTitle,
	JSON.stringify(filled?.payload),
);
const stagedCompleted = run.pi.emitted
	.filter((e) => e.ch === "tui_handoff_completed")
	.pop();
check(
	"staging emits tui_handoff_completed (delayed-Enter auto-submit; command path has no agent_end)",
	stagedCompleted !== undefined &&
		stagedCompleted.payload.sessionTitle === VALID_TITLE,
	JSON.stringify(stagedCompleted?.payload),
);
check(
	"staging emits tui_handoff_completed AFTER the editor fill",
	run.order.indexOf("setEditorText") !== -1 &&
		run.order.lastIndexOf("emit:tui_handoff_completed") >
			run.order.indexOf("setEditorText"),
	JSON.stringify(run.order),
);
check(
	"completion precedes the editor fill",
	run.order.indexOf("emit:handoff_command_complete") !== -1 &&
		run.order.indexOf("emit:handoff_command_complete") <
			run.order.indexOf("setEditorText"),
	JSON.stringify(run.order),
);
check("executor never creates a session", run.newSessionCalls === 0);

console.log("executor (missing ## Next Task):");
const runBad = await runExecutor(INVALID_DOC);
const completeBad = runBad.pi.emitted.find(
	(e) => e.ch === "handoff_command_complete",
);
const artifactBad: string = completeBad?.payload.artifactPath;
check(
	"invalid doc still saved under the handoff data dir",
	typeof artifactBad === "string" &&
		dirname(artifactBad) === join(agentExec, "data", "pi-handoff") &&
		existsSync(artifactBad),
	String(artifactBad),
);
check(
	"warning notify names the saved doc + the missing section",
	runBad.notes.some(
		(x) =>
			x.level === "warning" &&
			x.message.includes(artifactBad) &&
			x.message.includes("## Next Task"),
	),
	JSON.stringify(runBad.notes),
);
check(
	"invalid doc → no editor staging",
	runBad.editorTexts.length === 0,
	JSON.stringify(runBad.editorTexts),
);
check(
	"invalid doc → no tui_filled_handoff",
	!runBad.pi.emitted.some((e) => e.ch === "tui_filled_handoff"),
);
check(
	"invalid doc → error-tagged completion with artifact path",
	!!completeBad &&
		!!completeBad.payload.error &&
		completeBad.payload.artifactPath === artifactBad,
	JSON.stringify(completeBad?.payload),
);
check("invalid doc → no session created", runBad.newSessionCalls === 0);

// ── 4. continue tail: the staged command creates the new session ──
console.log("continue tail (staged /continue <docPath>):");
{
	const p = makeMockPi();
	process.env.PI_CODING_AGENT_DIR = agentExec;
	handoffExtension(p.pi);

	const staged = run.editorTexts[0] ?? "";
	const docArg = staged.replace(/^\/continue\s+/, "");

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
	const ctx = makeMockCtx({
		ui: { notify: () => {}, setEditorText: () => {} },
		newSession,
	});

	let threw = false;
	try {
		await p.commands.get("continue").handler(docArg, ctx);
	} catch {
		threw = true;
	}

	check(
		"staged command resolved to the saved doc path",
		docArg === artifactPath,
		`${staged} vs ${artifactPath}`,
	);
	check("handler survives replacement (no stale throw)", !threw);
	const visible = [
		...state.appended.filter((m) => m.role === "user"),
		...state.liveMessages,
	];
	check(
		"exactly one visible user message in the new session",
		visible.length === 1,
		JSON.stringify(visible),
	);
	check(
		"live message = doc path + read-first + task + canonical PA",
		state.liveMessages[0] === continuationPrompt(artifactPath, VALID_TASK),
		JSON.stringify(state.liveMessages),
	);
	check(
		"no seeded '## Handoff Context' reference",
		!JSON.stringify(state.appended).includes("## Handoff Context") &&
			!state.liveMessages.some((t) => t.includes("## Handoff Context")),
		JSON.stringify(state.appended),
	);
	check(
		"hidden handoff-origin entry carries details.docPath",
		state.appended.length === 1 &&
			state.appended[0].role === "custom" &&
			state.appended[0].customType === "handoff-origin" &&
			state.appended[0].display === false &&
			state.appended[0].details?.docPath === artifactPath,
		JSON.stringify(state.appended),
	);
	check(
		"session title derives from the Next Task, not the doc path",
		state.sessionInfo[0] === VALID_TITLE &&
			!state.sessionInfo[0].startsWith("Handoff document:"),
		String(state.sessionInfo[0]),
	);
	const completeTail = p.emitted.filter(
		(e) => e.ch === "handoff_command_complete",
	)[0];
	check(
		"complete carries the task-derived title + artifact path (success)",
		completeTail?.payload.sessionTitle === VALID_TITLE &&
			completeTail?.payload.artifactPath === artifactPath &&
			completeTail?.payload.error === undefined,
		JSON.stringify(completeTail?.payload),
	);
	check(
		"complete emitted BEFORE the session-replacement boundary",
		order.indexOf("emit:handoff_command_complete") !== -1 &&
			order.indexOf("emit:handoff_command_complete") < order.indexOf("newSession"),
		JSON.stringify(order),
	);
}

// ── 5. continue tool — valid doc + repair loop ──
console.log("continue tool:");
const agentTool = scratchDir("pih-tool-");
process.env.PI_CODING_AGENT_DIR = agentTool;
const toolDocPath = writeDoc(agentTool, "handoff-tool.md", VALID_DOC);
const toolEditorTexts: string[] = [];
const toolCtx = makeMockCtx({
	cwd: agentTool,
	ui: {
		notify: () => {},
		setEditorText: (t: string) => toolEditorTexts.push(t),
	},
});
const ok = await s.tools
	.get("continue")
	.execute("t1", { docPath: toolDocPath }, undefined, undefined, toolCtx);
check("valid doc → no isError", !ok.isError, JSON.stringify(ok));
check(
	"editor prefilled with /continue",
	toolEditorTexts[0] === `/continue ${toolDocPath}`,
	String(toolEditorTexts),
);
check(
	"tui_filled_handoff emitted with { goal: title, command }",
	s.emitted.some(
		(e) =>
			e.ch === "tui_filled_handoff" &&
			e.payload.command === `/continue ${toolDocPath}` &&
			e.payload.goal === VALID_TITLE,
	),
	JSON.stringify(s.emitted),
);
check(
	"details carry the canonical liveMessage",
	ok.details?.liveMessage === continuationPrompt(toolDocPath, VALID_TASK),
	JSON.stringify(ok.details),
);

const badPath = writeDoc(agentTool, "handoff-bad.md", INVALID_DOC);
const bad = await s.tools
	.get("continue")
	.execute("t2", { docPath: badPath }, undefined, undefined, toolCtx);
check("invalid doc → isError", bad.isError === true);
check(
	"repair hint mentions ## Next Task",
	bad.content[0].text.includes("## Next Task"),
);
const missing = await s.tools
	.get("continue")
	.execute(
		"t3",
		{ docPath: join(agentTool, "nope.md") },
		undefined,
		undefined,
		toolCtx,
	);
check(
	"missing file → isError + write hint",
	missing.isError === true &&
		missing.content[0].text.includes("Write the handoff document"),
);
check(
	"repair hint says create parent dir",
	missing.content[0].text.includes("create the parent directory"),
);

// ── 6. /continue modes ──
console.log("/continue modes:");
{
	// bare → newest doc in the handoff data dir
	const agentDocs = scratchDir("pih-docs-");
	process.env.PI_CODING_AGENT_DIR = agentDocs;
	writeDoc(
		agentDocs,
		"handoff-2026-01-01T00-00-00-000Z.md",
		"# Handoff\n\n## Next Task\nOlder task.\n",
	);
	const newestPath = writeDoc(
		agentDocs,
		"handoff-2026-02-02T00-00-00-000Z.md",
		"# Handoff\n\n## Next Task\nNewer task.\n",
	);

	const p = makeMockPi();
	handoffExtension(p.pi);
	const { state, newSession } = makeSessionCapture();
	await p.commands
		.get("continue")
		.handler(
			"",
			makeMockCtx({
				ui: { notify: () => {}, setEditorText: () => {} },
				newSession,
			}),
		);
	check(
		"bare /continue → newest doc drives the live message",
		state.liveMessages[0] === continuationPrompt(newestPath, "Newer task."),
		JSON.stringify(state.liveMessages),
	);
	check(
		"bare /continue → hidden origin entry records the newest doc path",
		state.appended[0]?.details?.docPath === newestPath,
		JSON.stringify(state.appended),
	);

	// generic text → as-is, nothing seeded
	const p2 = makeMockPi();
	handoffExtension(p2.pi);
	const cap2 = makeSessionCapture();
	const genericText = "now implement the parser module";
	await p2.commands
		.get("continue")
		.handler(
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
		!cap2.state.appended.some(
			(m) => m.role === "user" || JSON.stringify(m).includes("Handoff Context"),
		),
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

	// no docs anywhere → bare errors cleanly
	const agentNoDocs = scratchDir("pih-nodocs-");
	process.env.PI_CODING_AGENT_DIR = agentNoDocs;
	const p3 = makeMockPi();
	handoffExtension(p3.pi);
	const notes: string[] = [];
	await p3.commands
		.get("continue")
		.handler(
			"",
			makeMockCtx({
				ui: { notify: (m: string) => notes.push(m), setEditorText: () => {} },
			}),
		);
	check(
		"bare with no docs → clean error",
		notes.some((m) => m.includes("No handoff documents")),
		JSON.stringify(notes),
	);
}

// ── 7. lifecycle pairing (invalid doc via /continue <path>) ──
console.log("lifecycle pairing:");
{
	const p = makeMockPi();
	process.env.PI_CODING_AGENT_DIR = agentTool;
	handoffExtension(p.pi);
	const badCommandPath = writeDoc(
		agentTool,
		"handoff-invalid.md",
		"# no next task section",
	);
	await p.commands
		.get("continue")
		.handler(
			badCommandPath,
			makeMockCtx({ ui: { notify: () => {}, setEditorText: () => {} } }),
		);
	const pairs = p.emitted.filter((e) => e.ch === "handoff_command_complete");
	check(
		"invalid doc → start+complete pair with error",
		p.emitted[0]?.ch === "handoff_command_start" &&
			pairs.length === 1 &&
			!!pairs[0].payload.error,
		JSON.stringify(p.emitted),
	);
}

console.log(
	failures === 0 ? "\nALL SMOKE CHECKS PASSED" : `\n${failures} FAILURES`,
);
process.exit(failures === 0 ? 0 : 1);
