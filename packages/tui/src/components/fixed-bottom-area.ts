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

interface SgrMousePacket {
	code: number;
	col: number;
	row: number;
	final: "M" | "m";
}

interface SelectionPoint {
	line: number;
	col: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Strip ANSI escape sequences and OSC sequences from a string. */
function stripAnsi(line: string): string {
	return line.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** Slice text by visual columns. */
function sliceColumns(text: string, startCol: number, endCol: number): string {
	let col = 0;
	let result = "";
	for (const { segment } of graphemeSegmenter.segment(stripAnsi(text))) {
		const width = Math.max(0, visibleWidth(segment));
		if (col >= startCol && col < endCol) {
			result += segment;
		}
		col += width;
	}
	return result;
}

function comparePoints(a: SelectionPoint, b: SelectionPoint): number {
	return a.line === b.line ? a.col - b.col : a.line - b.line;
}

// ── FixedBottomArea ─────────────────────────────────────────────────────────

/**
 * Pins components to the bottom of the terminal using scroll regions.
 *
 * Supports mouse-wheel scrolling and mouse text selection
 * (drag to select, releases to clipboard via onCopySelection callback).
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

	// Mouse text selection state
	private selectionAnchor: SelectionPoint | null = null;
	private selectionFocus: SelectionPoint | null = null;
	private selectionDragging = false;
	private visibleScrollStart = 0;
	private scrollableLines: string[] = [];

	/** Callback: render the fixed cluster given the terminal width. */
	public renderCluster: ((width: number) => FixedAreaCluster) | null = null;

	/** Callback: copy selected text to clipboard. */
	public onCopySelection: ((text: string) => void) | null = null;

	constructor(tui: TUI) {
		this.tui = tui;
		this.originalWrite = tui.terminal.write.bind(tui.terminal);

		let target: object | null = tui.terminal;
		while (target) {
			const desc = Object.getOwnPropertyDescriptor(target, "rows");
			if (desc) {
				this.originalRowsDescriptor = desc;
				break;
			}
			target = Object.getPrototypeOf(target);
		}

		if (this.originalRowsDescriptor?.get) {
			this.originalRowsValue = undefined;
		} else {
			this.originalRowsValue = (tui.terminal as any).rows as number;
		}
	}

	// ── Public API ──────────────────────────────────────────────────────────

	hideComponent(component: Component): void {
		if (this.hiddenComponents.has(component)) return;
		this.hiddenComponents.set(component, component.render.bind(component));
		component.render = () => [];
	}

	renderHidden(component: Component, width: number): string[] {
		const render = this.hiddenComponents.get(component);
		return render ? render(width) : component.render(width);
	}

	unhideComponent(component: Component): void {
		const original = this.hiddenComponents.get(component);
		if (original) {
			component.render = original;
			this.hiddenComponents.delete(component);
		}
	}

	setReservedHeight(rows: number): void {
		this.cachedClusterLines = rows;
	}

	scrollUp(lines = 1): void {
		if (!this.installed) return;
		this.scrollOffset += lines;
		this.wasAtBottom = false;
		this.clearSelection();
		this.tui.requestRender();
	}

	scrollDown(lines = 1): void {
		if (!this.installed) return;
		this.scrollOffset = Math.max(0, this.scrollOffset - lines);
		if (this.scrollOffset === 0) this.wasAtBottom = true;
		this.clearSelection();
		this.tui.requestRender();
	}

	scrollToBottom(): void {
		if (this.scrollOffset === 0) return;
		this.scrollOffset = 0;
		this.wasAtBottom = true;
		this.clearSelection();
		this.tui.requestRender();
	}

	isAtBottom(): boolean {
		return this.scrollOffset === 0;
	}

	// ── Install / Dispose ───────────────────────────────────────────────────

	install(): void {
		if (this.installed) return;

		this.originalWrite(BEGIN_SYNC + ALT_SCREEN_ENTER + ALT_SCROLL_OFF + MOUSE_ENABLE + END_SYNC);

		const emergencyCleanup = () => {
			if (this.installed) this.dispose();
		};
		process.once("exit", emergencyCleanup);

		Object.defineProperty(this.tui.terminal, "rows", {
			configurable: true,
			get: () => this.getScrollableRows(),
		});

		this.originalRender = this.tui.render.bind(this.tui);
		this.tui.render = (width: number) => this.renderScrollable(width);

		this.removeInputListener = this.tui.addInputListener((data) => this.handleInput(data));

		this.tui.terminal.write = (data: string) => this.write(data);

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

		for (const [component, originalRender] of this.hiddenComponents) {
			component.render = originalRender;
		}
		this.hiddenComponents.clear();

		this.removeInputListener?.();
		this.removeInputListener = null;

		this.tui.terminal.write = this.originalWrite;
		if (this.originalDoRender) {
			(this.tui as any).doRender = this.originalDoRender;
		}
		if (this.originalRender) {
			this.tui.render = this.originalRender;
		}

		if (this.originalRowsDescriptor) {
			Object.defineProperty(this.tui.terminal, "rows", this.originalRowsDescriptor);
		} else {
			Reflect.deleteProperty(this.tui.terminal, "rows");
		}

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
		this.scrollableLines = lines;
		this.lastContentLineCount = lines.length;

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
		this.visibleScrollStart = start;
		const visible = lines.slice(start, start + scrollableRows);

		// Apply selection highlighting to visible lines
		return visible.map((line, i) => this.highlightSelection(line, start + i));
	}

	private write(data: string): void {
		const rawRows = this.getRawRows();
		const clusterHeight = this.cachedClusterLines;
		const scrollBottom = Math.max(1, rawRows - clusterHeight);

		if (clusterHeight === 0 || rawRows <= 2) {
			this.originalWrite(data);
			return;
		}

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

		const showHwCursor = this.tui.getShowHardwareCursor?.() ?? false;
		if (showHwCursor && cluster.cursorRow >= 0 && cluster.cursorCol >= 0) {
			buffer += moveCursor(startRow + cluster.cursorRow, Math.max(1, cluster.cursorCol + 1));
			buffer += SHOW_CURSOR;
		} else {
			buffer += HIDE_CURSOR;
		}

		return buffer;
	}

	// ── Input handling ──────────────────────────────────────────────────────

	private handleInput(data: string): { consume?: boolean; data?: string } | undefined {
		if (!this.installed) return undefined;
		if (isKeyRelease(data)) return undefined;

		// Parse SGR mouse packets
		const mousePackets = this.parseSgrMouse(data);
		if (mousePackets) {
			for (const packet of mousePackets) {
				this.handleMouse(packet);
			}
			return { consume: true };
		}

		// Keyboard scroll
		if (matchesKey(data, "ctrl+shift+up") || matchesKey(data, "pageUp")) {
			this.scrollUp(10);
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+shift+down") || matchesKey(data, "pageDown")) {
			this.scrollDown(10);
			return { consume: true };
		}

		// Auto-scroll to bottom when typing
		if (!this.isAtBottom() && data.length === 1 && data.charCodeAt(0) >= 32) {
			this.scrollToBottom();
		}

		return undefined;
	}

	// ── SGR Mouse parsing ───────────────────────────────────────────────────

	private parseSgrMouse(data: string): SgrMousePacket[] | null {
		const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
		const packets: SgrMousePacket[] = [];
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

	private mouseBaseButton(code: number): number {
		return code & ~(4 | 8 | 16 | 32);
	}

	private mouseScrollDelta(packet: SgrMousePacket): number {
		if (packet.final !== "M") return 0;
		const base = this.mouseBaseButton(packet.code);
		if (base === 64) return 3;
		if (base === 65) return -3;
		return 0;
	}

	private isLeftPress(packet: SgrMousePacket): boolean {
		return packet.final === "M" && this.mouseBaseButton(packet.code) === 0 && (packet.code & 32) === 0;
	}

	private isLeftDrag(packet: SgrMousePacket): boolean {
		return packet.final === "M" && this.mouseBaseButton(packet.code) === 0 && (packet.code & 32) !== 0;
	}

	// ── Mouse event handling ────────────────────────────────────────────────

	private handleMouse(packet: SgrMousePacket): void {
		// Scroll wheel
		const delta = this.mouseScrollDelta(packet);
		if (delta !== 0) {
			this.selectionDragging = false;
			this.clearSelection();
			if (delta > 0) this.scrollUp(delta);
			else this.scrollDown(-delta);
			return;
		}

		// Left press: start selection
		if (this.isLeftPress(packet)) {
			const pos = { line: this.visibleScrollStart + packet.row - 1, col: Math.max(0, packet.col - 1) };
			this.selectionAnchor = pos;
			this.selectionFocus = pos;
			this.selectionDragging = true;
			this.tui.requestRender();
			return;
		}

		// Left drag: update selection focus
		if (this.selectionDragging && this.isLeftDrag(packet)) {
			this.selectionFocus = {
				line: this.visibleScrollStart + packet.row - 1,
				col: Math.max(0, packet.col - 1),
			};
			this.tui.requestRender();
			return;
		}

		// Any release: finish selection
		if (packet.final === "m" && this.selectionDragging) {
			this.selectionDragging = false;
			const text = this.getSelectedText();
			if (text && this.onCopySelection) {
				this.onCopySelection(text);
			}
			this.clearSelection();
			this.tui.requestRender();
			return;
		}
	}

	// ── Text selection ──────────────────────────────────────────────────────

	private clearSelection(): void {
		this.selectionAnchor = null;
		this.selectionFocus = null;
		this.selectionDragging = false;
	}

	private getSelectionRange(): { start: SelectionPoint; end: SelectionPoint } | null {
		if (!this.selectionAnchor || !this.selectionFocus) return null;

		if (comparePoints(this.selectionAnchor, this.selectionFocus) <= 0) {
			return { start: this.selectionAnchor, end: this.selectionFocus };
		}
		return { start: this.selectionFocus, end: this.selectionAnchor };
	}

	private highlightSelection(line: string, lineIndex: number): string {
		const range = this.getSelectionRange();
		if (!range || lineIndex < range.start.line || lineIndex > range.end.line) return line;

		const plain = stripAnsi(line);
		const startCol = lineIndex === range.start.line ? range.start.col : 0;
		const endCol = lineIndex === range.end.line ? range.end.col : visibleWidth(plain);
		if (startCol >= endCol) return line;

		const before = sliceColumns(plain, 0, startCol);
		const selected = sliceColumns(plain, startCol, endCol);
		const after = sliceColumns(plain, endCol, Number.POSITIVE_INFINITY);

		return `${before}\x1b[7m${selected}\x1b[27m${after}`;
	}

	private getSelectedText(): string {
		const range = this.getSelectionRange();
		if (!range) return "";

		const selected: string[] = [];
		for (let i = range.start.line; i <= range.end.line; i++) {
			const line = stripAnsi(this.scrollableLines[i] ?? "");
			const startCol = i === range.start.line ? range.start.col : 0;
			const endCol = i === range.end.line ? range.end.col : visibleWidth(line);
			selected.push(sliceColumns(line, startCol, endCol));
		}

		return selected
			.join("\n")
			.replace(/[ \t]+$/gm, "")
			.trimEnd();
	}
}
