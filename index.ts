/**
 * Handoff extension — transfer context to a new focused session.
 *
 * Entry point that wires together tools, commands, and event hooks.
 *
 * Unified flow (2026-09-12; no-doc rehaul 2026-09-13): every session
 * registers the same three surfaces — the `/handoff` command (cold path:
 * one-off LLM call on `handoff.provider/model` that launches the new session
 * DIRECTLY — no document file is written) and the `/continue` command +
 * `continue` tool (warm path: the `pi-handoff` skill flow, document passed
 * inline). Both entry points converge on the same tail: createHandoffSession
 * seeds the new session with the filled document as its first message.
 * `handoff.type` is parsed for backward compatibility but
 * ignored (see `domain/types.ts`).
 *
 * The pi-handoff skill is the primary instruction source for agents
 * performing handoffs.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadHandoffSettings } from "./infrastructure/config-repository";
import { registerContinueTool } from "./tools/continue";
import { registerHandoffCommandDetached } from "./commands/handoff";
import { registerContinueCommand } from "./commands/continue";
import { registerHandoffEvents } from "./infrastructure/event-registration";

export default function handoffExtension(pi: ExtensionAPI): void {
 registerHandoffEvents(pi);

 // Unified flow: /handoff is available in every session and routes into
 // /continue instead of replacing the session. All three surfaces register
 // unconditionally — `handoff.type` no longer selects a registration path.
 const settings = loadHandoffSettings();
 registerHandoffCommandDetached(pi, settings);
 registerContinueCommand(pi);
 registerContinueTool(pi);
}
