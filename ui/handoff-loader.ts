/**
 * Handoff generation loader UI.
 *
 * Wraps BorderedLoader with the abort behaviour expected by the prompt
 * generator: aborting returns `null` to the caller via a callback.
 */

import type { TUI } from "@earendil-works/pi-tui";
import { BorderedLoader, type Theme } from "@earendil-works/pi-coding-agent";

export class HandoffLoader extends BorderedLoader {
	constructor(tui: TUI, theme: Theme, label: string, onAbort: () => void) {
		super(tui, theme, label);
		this.onAbort = onAbort;
	}
}
