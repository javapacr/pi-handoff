/**
 * Load + behavioral smoke for pi-handoff (agent-driven in-session redesign).
 * Run: npm test (from the repo root).
 *
 * Self-staging: the repo package.json has no "type": "module" (tsx would
 * transform the extension as CJS and its require-hook bypasses ESM module
 * hooks), and the repo devDep versions of @earendil-works/* drift from pi's
 * runtime aliases. So we copy the repo's .ts tree into a temp ESM context,
 * register module hooks that stub those packages, and import the staged
 * index.ts.
 */
import { cpSync, mkdtempSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const stage = mkdtempSync(join(tmpdir(), "pih-stage-"));
cpSync(repoRoot, stage, {
	recursive: true,
	filter: (s) => {
		const rel = relative(repoRoot, s);
		if (rel.split(sep).some((part) => ["node_modules", "dist", ".git", "test"].includes(part)))
			return false;
		return statSync(s).isDirectory() || s.endsWith(".ts");
	},
});
writeFileSync(join(stage, "package.json"), JSON.stringify({ type: "module" }));
const repo = stage;

const { default: handoffExtension } = await import(join(repo, "index.ts"));
const {
	findNextTaskContent,
	buildContinuationPrompt,
} = await import(join(repo, "domain/handoff-prompt.ts"));

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

function makeMockPi() {
	const commands = new Map();
	const tools = new Map();
	const eventsOn: Array<[string, Function]> = [];
	const apiOn: Array<[string, Function]> = [];
	const emitted: Array<{ ch: string; payload: any }> = [];
	const editorTexts: string[] = [];
	const pi: any = {
		registerCommand: (name: string, opts: any) => commands.set(name, opts),
		registerTool: (def: any) => tools.set(def.name, def),
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
	return { pi, commands, tools, apiOn, eventsOn, emitted, editorTexts };
}

function makeMockCtx(over: any = {}) {
	const mock = {
		mode: "tui",
		cwd: tmpdir(),
		ui: { notify: () => {}, setEditorText: (t: string) => mock.editorTexts.push(t) },
		sessionManager: {
			getBranch: () => [
				{ id: "e1", type: "message", message: { role: "user", content: "hello" } },
			],
			getSessionFile: () => "/tmp/fake-session.jsonl",
			getLeafId: () => "leaf-1",
		},
		...over,
	} as any;
	(mock as any).editorTexts = mock.ui ? undefined : undefined;
	return mock;
}

// ── 1. pure domain helpers ──
console.log("domain helpers:");
check("missing heading → null", findNextTaskContent("## Context\nfoo") === null);
check("empty section → null", findNextTaskContent("## Next Task\n\n## Phase Adherence\n") === null);
check(
	"content excludes trailing Phase Adherence section",
	findNextTaskContent("## Context\nx\n\n## Next Task\nDo the thing.\n\n## Phase Adherence\nmodel variant") === "Do the thing.",
);
check(
	"multiple headings → last wins",
	findNextTaskContent("## Next Task\nold\n\n## Next Task\nnew task") === "new task",
);
check(
	"continuation prompt = content + canonical PA",
	buildContinuationPrompt("## Next Task\nDo the thing.\n\n## Phase Adherence\nmodel variant") === `Do the thing.\n\n${CANONICAL_PA}`,
);
check("invalid doc → continuation null", buildContinuationPrompt("## Context\nx") === null);

// ── 2. detached branch (default) ──
console.log("detached branch:");
const agentDetached = mkdtempSync(join(tmpdir(), "pih-detach-"));
process.env.PI_CODING_AGENT_DIR = agentDetached;
const d = makeMockPi();
handoffExtension(d.pi);
check("registers /handoff", d.commands.has("handoff"));
check("no /continue in detached", !d.commands.has("continue"));
check("request_handoff registered", d.tools.has("request_handoff"));
check("no continue tool in detached", !d.tools.has("continue"));

// ── 3. in-session branch — agent-driven, NO /handoff ──
console.log("in-session branch:");
const agentInSession = mkdtempSync(join(tmpdir(), "pih-insession-"));
writeFileSync(
	join(agentInSession, "settings.json"),
	JSON.stringify({ handoff: { type: "in-session" } }),
);
process.env.PI_CODING_AGENT_DIR = agentInSession;
const s = makeMockPi();
handoffExtension(s.pi);
check("registers /continue", s.commands.has("continue"));
check("registers continue tool", s.tools.has("continue"));
check("NO /handoff in in-session (skill replaces it)", !s.commands.has("handoff"));
check("NO request_handoff in in-session", !s.tools.has("request_handoff"));

// 3a. continue tool — valid doc
mkdirSync(join(agentInSession, "data", "pi-handoff"), { recursive: true });
const docPath = join(agentInSession, "data", "pi-handoff", "handoff-test.md");
writeFileSync(
	docPath,
	"# Handoff\n\n## Context\nDid stuff.\n\n## Next Task\nShip the redesign.\n\n## Phase Adherence\nmodel-authored variant",
);
const launchCtx = makeMockCtx({ ui: { notify: () => {}, setEditorText: (t: string) => s.editorTexts.push(t) } });
const ok = await s.tools.get("continue").execute("t1", { docPath }, undefined, undefined, launchCtx);
check("valid doc → no isError", !ok.isError, JSON.stringify(ok));
check("editor prefilled with /continue", s.editorTexts[0] === `/continue ${docPath}`, String(s.editorTexts));
check(
	"tui_filled_handoff emitted",
	s.emitted.some((e) => e.ch === "tui_filled_handoff" && e.payload.command === `/continue ${docPath}`),
);
check("details carry canonical liveMessage", ok.details?.liveMessage === `Ship the redesign.\n\n${CANONICAL_PA}`, JSON.stringify(ok.details));

// 3b. continue tool — repair loop
const badPath = join(agentInSession, "data", "pi-handoff", "handoff-bad.md");
writeFileSync(badPath, "# Handoff\n\n## Context\nNo next task here.");
const bad = await s.tools.get("continue").execute("t2", { docPath: badPath }, undefined, undefined, launchCtx);
check("invalid doc → isError", bad.isError === true);
check("repair hint mentions ## Next Task", bad.content[0].text.includes("## Next Task"));
const missing = await s.tools
	.get("continue")
	.execute("t3", { docPath: join(agentInSession, "nope.md") }, undefined, undefined, launchCtx);
check("missing file → isError + write hint", missing.isError === true && missing.content[0].text.includes("Write the handoff document"));
check("repair hint says create parent dir", missing.content[0].text.includes("create the parent directory"));

// ── 4. lifecycle pairing ──
console.log("lifecycle pairing:");
{
	const p = makeMockPi();
	process.env.PI_CODING_AGENT_DIR = agentInSession;
	handoffExtension(p.pi);
	const badDoc = join(agentInSession, "data", "pi-handoff", "handoff-invalid.md");
	writeFileSync(badDoc, "# no next task section");
	await p.commands.get("continue").handler(badDoc, makeMockCtx({ ui: { notify: () => {}, setEditorText: () => {} } }));
	const complete = p.emitted.filter((e) => e.ch === "handoff_command_complete");
	check("invalid doc → start+complete pair with error", complete.length === 1 && !!complete[0].payload.error, JSON.stringify(p.emitted));
}

// ── 5. stale-ctx ordering ──
console.log("stale-ctx ordering:");
{
	const p = makeMockPi();
	process.env.PI_CODING_AGENT_DIR = agentInSession;
	handoffExtension(p.pi);
	let stale = false;
	const order: string[] = [];
	p.pi.events.emit = (ch: string, payload: any) => {
		if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
		order.push("emit:" + ch);
		p.emitted.push({ ch, payload });
	};
	let p2doc = join(agentInSession, "data", "pi-handoff", "handoff-order.md");
	const ctxL = makeMockCtx({
		ui: { notify: () => {}, setEditorText: (t: string) => p.editorTexts.push(t) },
		newSession: async (opts: any) => {
			stale = true;
			order.push("newSession");
			await opts.setup?.({ appendSessionInfo: () => {}, appendMessage: () => {} });
			await opts.withSession?.({ sendUserMessage: async () => {}, ui: { notify: () => {} } });
			return { cancelled: false };
		},
	});
	writeFileSync(p2doc, "## Context\nx\n\n## Next Task\nOrder check.\n\n## Phase Adherence\nM.");
	let threw = false;
	try {
		await p.commands.get("continue").handler(p2doc, ctxL);
	} catch {
		threw = true;
	}
	check("handler survives replacement (no stale throw)", !threw);
	const ci = order.indexOf("emit:handoff_command_complete"), ni = order.indexOf("newSession");
	check("complete emitted BEFORE newSession", ci !== -1 && ni !== -1 && ci < ni, JSON.stringify(order));
}

// ── 6. /continue modes ──
console.log("/continue modes:");
{
	// bare → newest doc
	const p = makeMockPi();
	process.env.PI_CODING_AGENT_DIR = agentInSession;
	handoffExtension(p.pi);
	const seeded: string[] = [];
	const live: string[] = [];
	const ctxN = makeMockCtx({
		ui: { notify: () => {}, setEditorText: () => {} },
		newSession: async (opts: any) => {
			await opts.setup?.({
				appendSessionInfo: () => {},
				appendMessage: (m: any) =>
					seeded.push(typeof m.content === "string" ? m.content : m.content?.map?.((c: any) => c.text).join("") ?? ""),
			});
			await opts.withSession?.({ sendUserMessage: async (t: string) => live.push(t), ui: { notify: () => {} } });
			return { cancelled: false };
		},
	});
	await p.commands.get("continue").handler("", ctxN);
	check("bare: seeded reference names newest doc", seeded.some((t) => t.includes("Handoff document: ") && t.includes("handoff-test.md")), JSON.stringify(seeded));
	check("bare: live message = canonical continuation", live[0] === `Ship the redesign.\n\n${CANONICAL_PA}`, JSON.stringify(live));

	// generic text → as-is, nothing seeded
	const p2 = makeMockPi();
	handoffExtension(p2.pi);
	const seeded2: string[] = [];
	const live2: string[] = [];
	const ctxG = makeMockCtx({
		ui: { notify: () => {}, setEditorText: () => {} },
		newSession: async (opts: any) => {
			await opts.setup?.({
				appendSessionInfo: () => {},
				appendMessage: (m: any) => seeded2.push(typeof m.content === "string" ? m.content : ""),
			});
			await opts.withSession?.({ sendUserMessage: async (t: string) => live2.push(t), ui: { notify: () => {} } });
			return { cancelled: false };
		},
	});
	const genericText = "now implement the parser module";
	await p2.commands.get("continue").handler(genericText, ctxG);
	check("generic: live message is text as-is", live2[0] === genericText, JSON.stringify(live2));
	check("generic: nothing seeded (no LLM-visible message)", !seeded2.some((t) => t.includes("Handoff Context")), JSON.stringify(seeded2));
	check("generic: complete emitted with title", p2.emitted.some((e) => e.ch === "handoff_command_complete" && e.payload.sessionTitle));

	// no docs anywhere → bare errors cleanly
	const p3 = makeMockPi();
	const emptyDir = mkdtempSync(join(tmpdir(), "pih-empty-"));
	writeFileSync(join(emptyDir, "settings.json"), JSON.stringify({ handoff: { type: "in-session" } }));
	process.env.PI_CODING_AGENT_DIR = emptyDir;
	handoffExtension(p3.pi);
	const notes: string[] = [];
	await p3.commands.get("continue").handler("", makeMockCtx({ ui: { notify: (m: string) => notes.push(m), setEditorText: () => {} } }));
	check("bare with no docs → clean error", notes.some((m) => m.includes("No handoff documents")), JSON.stringify(notes));
}

console.log(failures === 0 ? "\nALL SMOKE CHECKS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
