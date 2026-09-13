/**
 * Load + behavioral smoke for pi-handoff (unified flow: /handoff → /continue
 * → new session). Run: npm test (from the repo root).
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
	chmodSync,
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
import { basename, dirname, join, relative, sep } from "node:path";
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
const { findNextTaskContent, buildContinuationPrompt, deriveSessionTitle } =
	promptModule;
const { HANDOFF_OUTPUT_TEMPLATE, HANDOFF_TEMPLATE_VERSION } = await import(
	join(repo, "domain/handoff-template.ts")
);
const { PROVENANCE_HEADER_PREFIX, buildProvenanceHeader, isProvenanceStamped } =
	await import(join(repo, "domain/provenance.ts"));
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
	newSessionCalls: number;
	editorCalls: number;
	registry: RegistryCapture;
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
	} = {},
): Promise<ExecutorRun> {
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

	const capture = makeRegistryCapture(doc);
	capture.failModelIds = opts.failModelIds ?? [];

	const ctx = makeMockCtx({
		cwd: execCwd,
		modelRegistry: capture.registry,
		sessionBranch: opts.branch,
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

	await executeHandoff(
		p.pi,
		ctx,
		{ rawArgs: "" },
		{ diaryReminder: false, terminal: "tmux", ...opts.settings },
	);

	return {
		pi: p,
		notes,
		editorTexts,
		order,
		confirmCalls,
		compactCalls,
		newSessionCalls,
		editorCalls,
		registry: capture,
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
// Slice B: the detached save IS stamped — content === header line + "\n" + doc.
// The expected stamp is derived exactly as the executor writes it (same template
// literal, same mock session file); the saved timestamp is read back from the
// file and validated, never hardcoded.
const savedContent = existsSync(artifactPath)
	? readFileSync(artifactPath, "utf8")
	: null;
const savedHeader = savedContent?.split("\n", 1)[0];
const savedAt = savedHeader?.match(/ saved: (\S+) -->$/)?.[1];
check(
	"saved doc carries the provenance header as byte line 1",
	savedHeader !== undefined && savedHeader.startsWith(PROVENANCE_HEADER_PREFIX),
	JSON.stringify(savedContent?.slice(0, 120)),
);
check(
	"header stamps the mock session file + a parseable ISO-8601 saved time",
	savedHeader ===
		`<!-- pi-handoff v${HANDOFF_TEMPLATE_VERSION} | session: /tmp/fake-session.jsonl | saved: ${savedAt} -->` &&
		savedAt !== undefined &&
		!Number.isNaN(Date.parse(savedAt)),
	JSON.stringify(savedHeader),
);
check(
	"rest after the header line byte-equals the generated doc (stamp + newline + doc)",
	savedHeader !== undefined &&
		savedContent !== null &&
		savedContent.slice(savedHeader.length + 1) === VALID_DOC &&
		isProvenanceStamped(savedContent),
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
		"fallback still saves the doc + emits a success completion",
		!!completeFallback &&
			!completeFallback.payload.error &&
			typeof completeFallback.payload.artifactPath === "string" &&
			existsSync(completeFallback.payload.artifactPath),
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
		"origin entry profile = resolved agent dir; parentSession/goal/timestamp preserved (D8)",
		state.appended[0].details?.profile === agentExec &&
			state.appended[0].details?.parentSession === "/tmp/fake-session.jsonl" &&
			state.appended[0].details?.goal === null &&
			typeof state.appended[0].details?.timestamp === "number" &&
			state.appended[0].details?.templateVersion === undefined,
		JSON.stringify(state.appended[0].details),
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
				docPath: "/tmp/doc.md",
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

// ── 5b. continue tool — provenance stamp (D8) ──
console.log("continue tool — provenance stamp:");
{
	const stampDir = scratchDir("pih-stamp-");
	process.env.PI_CODING_AGENT_DIR = stampDir;
	const p = makeMockPi();
	handoffExtension(p.pi);
	const notes: Array<{ message: string; level?: string }> = [];
	const editorTexts: string[] = [];
	const makeToolCtx = () =>
		makeMockCtx({
			cwd: stampDir,
			ui: {
				notify: (message: string, level?: string) => notes.push({ message, level }),
				setEditorText: (t: string) => editorTexts.push(t),
			},
		});

	// Unstamped doc → stamped after tool success (atomic write respected).
	const unstampedPath = writeDoc(stampDir, "handoff-unstamped.md", VALID_DOC);
	const okStamp = await p.tools
		.get("continue")
		.execute(
			"t4",
			{ docPath: unstampedPath },
			undefined,
			undefined,
			makeToolCtx(),
		);
	const stampedOnDisk = readFileSync(unstampedPath, "utf8");
	const stampedHeader = stampedOnDisk.split("\n", 1)[0];
	const stampedAt = stampedHeader?.match(/ saved: (\S+) -->$/)?.[1];
	check(
		"unstamped doc → tool still succeeds",
		!okStamp.isError,
		JSON.stringify(okStamp),
	);
	check(
		"doc stamped after tool success — header line 1 with v-token + mock session file + ISO-8601",
		stampedHeader !== undefined &&
			stampedHeader.startsWith(PROVENANCE_HEADER_PREFIX) &&
			stampedHeader ===
				`<!-- pi-handoff v${HANDOFF_TEMPLATE_VERSION} | session: /tmp/fake-session.jsonl | saved: ${stampedAt} -->` &&
			stampedAt !== undefined &&
			!Number.isNaN(Date.parse(stampedAt)),
		JSON.stringify(stampedOnDisk.slice(0, 120)),
	);
	check(
		"stamped file body byte-equals the original doc",
		stampedHeader !== undefined &&
			stampedOnDisk.slice(stampedHeader.length + 1) === VALID_DOC,
	);
	check(
		"atomic write leaves no .tmp- residue",
		readdirSync(join(stampDir, "data", "pi-handoff")).every(
			(f) => !f.includes(".tmp-"),
		),
	);

	// Already-stamped doc → byte-unchanged (idempotent), no stamp notify.
	const preStamped =
		buildProvenanceHeader("/tmp/fake-session.jsonl") + VALID_DOC;
	const preStampedPath = writeDoc(stampDir, "handoff-prestamped.md", preStamped);
	const okPre = await p.tools
		.get("continue")
		.execute(
			"t5",
			{ docPath: preStampedPath },
			undefined,
			undefined,
			makeToolCtx(),
		);
	check("already-stamped doc → tool still succeeds", !okPre.isError);
	check(
		"already-stamped doc → file byte-unchanged (idempotent)",
		readFileSync(preStampedPath, "utf8") === preStamped,
	);
	check(
		"already-stamped doc → no stamp notify",
		!notes.some((n) => n.message.includes("provenance")),
		JSON.stringify(notes),
	);

	// Stamp failure (read-only agent dir) → notify-only; tool still succeeds.
	const roDir = scratchDir("pih-ro-");
	process.env.PI_CODING_AGENT_DIR = roDir;
	const p2 = makeMockPi();
	handoffExtension(p2.pi);
	const roNotes: Array<{ message: string; level?: string }> = [];
	const roEditor: string[] = [];
	const roPath = writeDoc(roDir, "handoff-ro.md", VALID_DOC);
	// The stamp writes into the DOC's directory — chmod THAT read-only.
	const roDataDir = join(roDir, "data", "pi-handoff");
	chmodSync(roDataDir, 0o555);
	let roResult: any;
	try {
		roResult = await p2.tools.get("continue").execute(
			"t6",
			{ docPath: roPath },
			undefined,
			undefined,
			makeMockCtx({
				cwd: roDir,
				ui: {
					notify: (message: string, level?: string) =>
						roNotes.push({ message, level }),
					setEditorText: (t: string) => roEditor.push(t),
				},
			}),
		);
	} finally {
		chmodSync(roDataDir, 0o755);
	}
	check(
		"stamp failure → tool still succeeds",
		roResult?.isError !== true,
		JSON.stringify(roResult),
	);
	check(
		"stamp failure → warning notify names the doc",
		roNotes.some((n) => n.level === "warning" && n.message.includes(roPath)) ===
			true,
		JSON.stringify(roNotes),
	);
	check(
		"stamp failure → editor still staged with /continue",
		roEditor[0] === `/continue ${roPath}`,
		JSON.stringify(roEditor),
	);
	check(
		"stamp failure → doc untouched on disk",
		readFileSync(roPath, "utf8") === VALID_DOC,
	);
}

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
	await p.commands.get("continue").handler(
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
	await p3.commands.get("continue").handler(
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

// ── 6b. hand-edited doc (user deleted the header) — D8 manual-edit survival ──
console.log("hand-edited doc — /continue stays write-free:");
{
	process.env.PI_CODING_AGENT_DIR = agentTool;
	const p = makeMockPi();
	handoffExtension(p.pi);
	const editedPath = writeDoc(agentTool, "handoff-edited.md", VALID_DOC);
	const { state, newSession } = makeSessionCapture();
	await p.commands.get("continue").handler(
		editedPath,
		makeMockCtx({
			ui: { notify: () => {}, setEditorText: () => {} },
			newSession,
		}),
	);
	check(
		"header-less (hand-edited) doc → /continue still launches",
		state.liveMessages.length === 1 && state.sessionInfo[0] === VALID_TITLE,
		JSON.stringify(state.liveMessages),
	);
	check(
		"live message byte-identical to the contract function (no header leak)",
		state.liveMessages[0] === continuationPrompt(editedPath, VALID_TASK),
		JSON.stringify(state.liveMessages),
	);
	check(
		"/continue performs no writes — file untouched (not re-stamped)",
		readFileSync(editedPath, "utf8") === VALID_DOC,
	);
	check(
		"origin entry still records the doc + profile (machine linkage survives manual edits)",
		state.appended[0]?.details?.docPath === editedPath &&
			state.appended[0]?.details?.profile === agentTool,
		JSON.stringify(state.appended),
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

console.log(
	failures === 0 ? "\nALL SMOKE CHECKS PASSED" : `\n${failures} FAILURES`,
);
process.exit(failures === 0 ? 0 : 1);
