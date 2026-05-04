import { isKeyRelease, matchesKey } from "../keys.js";
import type { Component, TUI } from "../tui.js";
import { truncateToWidth, visibleWidth } from "../utils.js";

// ── Terminal escape sequences ───────────────────────────────────────────────

const BEGIN_SYNC = "\x1b[?2026h";
const END_SYNC = "\x1b[?2026l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";
const ALT_SCROLL_OFF = "\x1b[?1007l";
const ALT_SCROLL_ON = "\x1b[?1007h";
const RESET_SCROLL = "\x1b[r";
const MOUSE_ENABLE = "\x1b[?1002h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

function setScrollRegion(top: number, bottom: number): string {
	return `\x1b[${top};${bottom}r`;
}

function moveCursor(row: number, col: number): string {
	return `\x1b[${row};${col}H`;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface FixedAreaCluster {
	lines: string[];
	cursorRow: number;
	cursorCol: number;
}

type RenderFn = (width: number) => string[];

// ── FixedBottomArea ─────────────────────────────────────────────────────────

/**
 * Pins components to the bottom of the terminal using scroll regions.
 *
 * Works by:
 * 1. Entering the alternate screen
 * 2. Setting a scroll region that excludes the bottom reserved rows
 * 3. Overriding terminal.rows so the TUI renders into the scrollable area only
 * 4. Hiding sticky components from the main render tree
 * 5. Painting them separately in the reserved bottom rows
 *
 * Keyboard scroll is handled via a TUI input listener.
 */
export class FixedBottomArea {
	private tui: TUI;
	private hiddenComponents: Map<Component, RenderFn> = new Map();
	private removeInputListener: (() => void) | null = null;
	private originalWrite: (data: string) => void;
	private originalRowsDescriptor: PropertyDescriptor | undefined;
	private originalRowsValue: number | undefined;
	private originalRender: ((w: number) => string[]) | undefined;
	private originalDoRender: (() => void) | undefined;
	private installed = false;
	private scrollOffset = 0;
	private lastContentLineCount = 0;
	private wasAtBottom = true;

	// Guards against recursion when getScrollableRows calls renderCluster
	private computingRows = false;
	private renderingCluster = false;
	private cachedClusterLines = 0;

	/** Callback: render the fixed cluster given the terminal width. */
	public renderCluster: ((width: number) => FixedAreaCluster) | null = null;

	constructor(tui: TUI) {
		this.tui = tui;
		this.originalWrite = tui.terminal.write.bind(tui.terminal);

		// Capture original rows descriptor for later restoration
		let target: object | null = tui.terminal;
		while (target) {
			const desc = Object.getOwnPropertyDescriptor(target, "rows");
			if (desc) {
				this.originalRowsDescriptor = desc;
				break;
			}
			target = Object.getPrototypeOf(target);
		}

		// Save original rows value (used to read real terminal height after override)
		if (this.originalRowsDescriptor?.get) {
			this.originalRowsValue = undefined; // will use getter each time
		} else {
			this.originalRowsValue = (tui.terminal as any).rows as number;
		}
	}

	// ── Public API ──────────────────────────────────────────────────────────

	/**
	 * Hide a component from the main render tree.
	 * Its original render function is saved so it can still be rendered
	 * inside the fixed cluster via renderHidden().
	 */
	hideComponent(component: Component): void {
		if (this.hiddenComponents.has(component)) return;
		this.hiddenComponents.set(component, component.render.bind(component));
		component.render = () => [];
	}

	/**
	 * Render a previously hidden component at the given width.
	 * Uses the saved original render function.
	 */
	renderHidden(component: Component, width: number): string[] {
		const render = this.hiddenComponents.get(component);
		return render ? render(width) : component.render(width);
	}

	/**
	 * Restore a previously hidden component's original render function.
	 */
	unhideComponent(component: Component): void {
		const original = this.hiddenComponents.get(component);
		if (original) {
			component.render = original;
			this.hiddenComponents.delete(component);
		}
	}

	/** Set the number of rows reserved at the bottom for the fixed cluster. */
	setReservedHeight(rows: number): void {
		this.cachedClusterLines = rows;
	}

	/** Scroll the content area up by n lines. Clamped during render. */
	scrollUp(lines = 1): void {
		if (!this.installed) return;
		this.scrollOffset += lines;
		this.wasAtBottom = false;
		this.tui.requestRender();
	}

	/** Scroll the content area down by n lines. Clamped during render. */
	scrollDown(lines = 1): void {
		if (!this.installed) return;
		this.scrollOffset = Math.max(0, this.scrollOffset - lines);
		if (this.scrollOffset === 0) this.wasAtBottom = true;
		this.tui.requestRender();
	}

	/** Scroll to the bottom of the content. */
	scrollToBottom(): void {
		if (this.scrollOffset === 0) return;
		this.scrollOffset = 0;
		this.wasAtBottom = true;
		this.tui.requestRender();
	}

	isAtBottom(): boolean {
		return this.scrollOffset === 0;
	}

	// ── Install / Dispose ───────────────────────────────────────────────────

	install(): void {
		if (this.installed) return;

		// Enter alternate screen with mouse reporting for scroll
		this.originalWrite(BEGIN_SYNC + ALT_SCREEN_ENTER + ALT_SCROLL_OFF + MOUSE_ENABLE + END_SYNC);

		// Emergency cleanup on process exit
		const emergencyCleanup = () => {
			if (this.installed) this.dispose();
		};
		process.once("exit", emergencyCleanup);

		// Override terminal.rows: TUI thinks it has fewer rows, renders into
		// the scrollable area naturally.
		Object.defineProperty(this.tui.terminal, "rows", {
			configurable: true,
			get: () => this.getScrollableRows(),
		});

		// Patch tui.render: insert scroll offset into the rendered lines
		this.originalRender = this.tui.render.bind(this.tui);
		this.tui.render = (width: number) => this.renderScrollable(width);

		// Intercept keyboard input for scroll
		this.removeInputListener = this.tui.addInputListener((data) => this.handleInput(data));

		// Patch terminal.write: redirect writes into the scroll region
		this.tui.terminal.write = (data: string) => this.write(data);

		// Patch doRender: repaint cluster after each render cycle.
		// This is needed because positionHardwareCursor hides the cursor
		// after our cluster paint shows it.
		const tuiAny = this.tui as any;
		this.originalDoRender = tuiAny.doRender?.bind(this.tui);
		tuiAny.doRender = () => {
			try {
				this.originalDoRender?.();
			} finally {
				this.repaintCluster();
			}
		};

		this.installed = true;
	}

	dispose(): void {
		if (!this.installed) return;
		this.installed = false;

		// Restore hidden components
		for (const [component, originalRender] of this.hiddenComponents) {
			component.render = originalRender;
		}
		this.hiddenComponents.clear();

		// Restore input listener
		this.removeInputListener?.();
		this.removeInputListener = null;

		// Restore terminal state
		this.tui.terminal.write = this.originalWrite;
		if (this.originalDoRender) {
			(this.tui as any).doRender = this.originalDoRender;
		}
		if (this.originalRender) {
			this.tui.render = this.originalRender;
		}

		// Restore terminal.rows
		if (this.originalRowsDescriptor) {
			Object.defineProperty(this.tui.terminal, "rows", this.originalRowsDescriptor);
		} else {
			Reflect.deleteProperty(this.tui.terminal, "rows");
		}

		// Exit alternate screen
		this.originalWrite(BEGIN_SYNC + RESET_SCROLL + MOUSE_DISABLE + ALT_SCROLL_ON + ALT_SCREEN_EXIT + END_SYNC);
	}

	// ── Internals ───────────────────────────────────────────────────────────

	private getRawRows(): number {
		if (this.originalRowsDescriptor?.get) {
			return this.originalRowsDescriptor.get.call(this.tui.terminal) as number;
		}
		return this.originalRowsValue ?? 24;
	}

	private repaintCluster(): void {
		const rawRows = this.getRawRows();
		if (this.cachedClusterLines === 0) return;
		this.originalWrite(BEGIN_SYNC + this.buildClusterPaint(rawRows) + END_SYNC);
	}

	private getScrollableRows(): number {
		if (!this.installed || this.computingRows || this.renderingCluster) {
			return this.getRawRows();
		}

		this.computingRows = true;
		try {
			const raw = this.getRawRows();
			const clusterHeight = this.getClusterHeight(raw);
			return Math.max(1, raw - clusterHeight);
		} finally {
			this.computingRows = false;
		}
	}

	/** Compute cluster height, with recursion guard. */
	private getClusterHeight(_rawRows: number): number {
		if (!this.renderCluster || this.renderingCluster) return this.cachedClusterLines;

		this.renderingCluster = true;
		try {
			const width = Math.max(1, this.tui.terminal.columns || 80);
			const cluster = this.renderCluster(width);
			this.cachedClusterLines = cluster.lines.length;
			return this.cachedClusterLines;
		} finally {
			this.renderingCluster = false;
		}
	}

	private renderScrollable(width: number): string[] {
		if (!this.originalRender) return [];

		const lines = this.originalRender(width);
		this.lastContentLineCount = lines.length;

		// Auto-scroll: if at bottom and content grew, stay at bottom.
		// If scrolled up and content grew, maintain relative position.
		if (lines.length > this.lastContentLineCount + this.scrollOffset) {
			if (this.wasAtBottom) {
				this.scrollOffset = 0;
			} else {
				this.scrollOffset += lines.length - this.lastContentLineCount;
			}
		}

		const scrollableRows = this.getScrollableRows();
		const maxScroll = Math.max(0, lines.length - scrollableRows);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const start = Math.max(0, lines.length - scrollableRows - this.scrollOffset);
		return lines.slice(start, start + scrollableRows);
	}

	private write(data: string): void {
		const rawRows = this.getRawRows();
		const clusterHeight = this.cachedClusterLines;
		const scrollBottom = Math.max(1, rawRows - clusterHeight);

		if (clusterHeight === 0 || rawRows <= 2) {
			this.originalWrite(data);
			return;
		}

		// Anchor writes to the correct screen position within the scroll region
		const hwCursorRow =
			typeof (this.tui as any).hardwareCursorRow === "number" ? (this.tui as any).hardwareCursorRow : 0;
		const viewportTop =
			typeof (this.tui as any).previousViewportTop === "number" ? (this.tui as any).previousViewportTop : 0;
		const screenRow = Math.max(1, Math.min(scrollBottom, hwCursorRow - viewportTop + 1));

		const buffer =
			BEGIN_SYNC +
			setScrollRegion(1, scrollBottom) +
			moveCursor(screenRow, 1) +
			data +
			this.buildClusterPaint(rawRows) +
			END_SYNC;

		this.originalWrite(buffer);
	}

	private buildClusterPaint(rawRows: number): string {
		if (!this.renderCluster) return "";

		const width = Math.max(1, this.tui.terminal.columns || 80);
		const cluster = this.renderCluster(width);

		if (cluster.lines.length === 0) return "";

		const startRow = Math.max(1, rawRows - cluster.lines.length + 1);
		let buffer = RESET_SCROLL;

		for (let i = 0; i < cluster.lines.length; i++) {
			const line = cluster.lines[i] ?? "";
			buffer += moveCursor(startRow + i, 1);
			buffer += CLEAR_LINE;
			buffer += visibleWidth(line) > width ? truncateToWidth(line, width, "", true) : line;
		}

		// Position hardware cursor within the cluster
		const showHwCursor = this.tui.getShowHardwareCursor?.() ?? false;
		if (showHwCursor && cluster.cursorRow >= 0 && cluster.cursorCol >= 0) {
			buffer += moveCursor(startRow + cluster.cursorRow, Math.max(1, cluster.cursorCol + 1));
			buffer += SHOW_CURSOR;
		} else {
			buffer += HIDE_CURSOR;
		}

		return buffer;
	}

	private handleInput(data: string): { consume?: boolean; data?: string } | undefined {
		if (!this.installed) return undefined;
		if (isKeyRelease(data)) return undefined;

		// Parse SGR mouse packets (format: \x1b[<CODE;COL;ROW[Mm])
		const mousePackets = this.parseSgrMouse(data);
		if (mousePackets) {
			for (const packet of mousePackets) {
				const delta = this.mouseScrollDelta(packet);
				if (delta !== 0) {
					if (delta > 0) this.scrollUp(delta);
					else this.scrollDown(-delta);
				}
			}
			return { consume: true };
		}

		// Keyboard scroll keys: ctrl+shift+up / ctrl+shift+down / pageUp / pageDown
		if (matchesKey(data, "ctrl+shift+up") || matchesKey(data, "pageUp")) {
			this.scrollUp(10);
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+shift+down") || matchesKey(data, "pageDown")) {
			this.scrollDown(10);
			return { consume: true };
		}

		// Auto-scroll to bottom when typing printable characters
		if (!this.isAtBottom() && data.length === 1 && data.charCodeAt(0) >= 32) {
			this.scrollToBottom();
		}

		return undefined;
	}

	/**
	 * Parse SGR mouse packets from input data.
	 * Format: \x1b[<CODE;COL;ROW[Mm]. Returns null if data is not mouse packets.
	 */
	private parseSgrMouse(data: string): Array<{ code: number; col: number; row: number; final: "M" | "m" }> | null {
		const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
		const packets: Array<{ code: number; col: number; row: number; final: "M" | "m" }> = [];
		let offset = 0;

		for (const match of data.matchAll(pattern)) {
			if (match.index !== offset) return null;
			offset = match.index + match[0].length;
			packets.push({
				code: Number(match[1]),
				col: Number(match[2]),
				row: Number(match[3]),
				final: match[4] as "M" | "m",
			});
		}

		return packets.length > 0 && offset === data.length ? packets : null;
	}

	/**
	 * Extract scroll delta from an SGR mouse packet.
	 * Base button 64 = scroll up (positive), 65 = scroll down (negative).
	 */
	private mouseScrollDelta(packet: { code: number; final: "M" | "m" }): number {
		if (packet.final !== "M") return 0;
		const baseButton = packet.code & ~(4 | 8 | 16 | 32);
		if (baseButton === 64) return 3;
		if (baseButton === 65) return -3;
		return 0;
	}
}
