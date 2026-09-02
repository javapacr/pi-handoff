/**
 * Handoff generation loader UI.
 *
 * Self-contained bordered loader that composes DynamicBorder + CancellableLoader
 * directly (BorderedLoader keeps its inner loader private, so its message cannot
 * be updated once mounted). Adds `setLine()` for streaming progress while
 * keeping the abort surface the prompt generator expects: aborting returns
 * `null` to the caller via the onAbort callback.
 */

import { DynamicBorder, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";

export class HandoffLoader extends Container {
	private loader: CancellableLoader;

	constructor(tui: TUI, theme: Theme, label: string, onAbort: () => void) {
		super();
		const borderColor = (s: string) => theme.fg("border", s);
		this.loader = new CancellableLoader(
			tui,
			(s) => theme.fg("accent", s),
			(s) => theme.fg("muted", s),
			label,
		);
		this.loader.onAbort = onAbort;
		this.addChild(new DynamicBorder(borderColor));
		this.addChild(this.loader);
		this.addChild(new Spacer(1));
		this.addChild(new Text(keyHint("tui.select.cancel", "cancel"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(borderColor));
	}

	get signal(): AbortSignal {
		return this.loader.signal;
	}

	set onAbort(fn: (() => void) | undefined) {
		this.loader.onAbort = fn;
	}

	handleInput(data: string): void {
		this.loader.handleInput(data);
	}

	dispose(): void {
		this.loader.dispose();
	}

	/** Update the loader message in place (streaming progress). */
	setLine(text: string): void {
		this.loader.setMessage(text);
	}
}
