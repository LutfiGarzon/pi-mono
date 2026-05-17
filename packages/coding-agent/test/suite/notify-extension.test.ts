import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import {
	notify,
	notifyMacOS,
	notifyOSC99,
	notifyOSC777,
	notifyWindows,
} from "../../examples/extensions/notify/index.js";

const mockedExecFile = vi.mocked(execFile);

describe("Notify extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		vi.clearAllMocks();
	});

	// ------------------------------------------------------------------
	// Platform-specific notification functions
	// ------------------------------------------------------------------

	describe("notifyMacOS", () => {
		it("calls a notification command with title and body", () => {
			notifyMacOS("Pi", "Done working");
			expect(mockedExecFile).toHaveBeenCalled();
			const [cmd, args] = mockedExecFile.mock.calls[0];
			expect(["osascript", "terminal-notifier"]).toContain(cmd);
			expect(args).toBeDefined();
		});
	});

	describe("notifyOSC777", () => {
		let stdoutWrites: string[];

		beforeEach(() => {
			stdoutWrites = [];
			vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
				stdoutWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
				return true;
			});
		});

		it("sends correct OSC 777 escape sequence", () => {
			notifyOSC777("Pi", "Done working");
			expect(stdoutWrites).toEqual(["\x1b]777;notify;Pi;Done working\x07"]);
		});
	});

	describe("notifyOSC99", () => {
		let stdoutWrites: string[];

		beforeEach(() => {
			stdoutWrites = [];
			vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
				stdoutWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
				return true;
			});
		});

		it("sends correct OSC 99 escape sequence", () => {
			notifyOSC99("Pi", "Done working");
			expect(stdoutWrites).toEqual(["\x1b]99;i=1:d=0;Pi\x1b\\", "\x1b]99;i=1:p=body;Done working\x1b\\"]);
		});
	});

	describe("notifyWindows", () => {
		it("calls powershell.exe with toast script", () => {
			notifyWindows("Pi", "Test body");
			expect(mockedExecFile).toHaveBeenCalledWith("powershell.exe", [
				"-NoProfile",
				"-Command",
				expect.stringContaining("ToastNotification"),
			]);
		});
	});

	// ------------------------------------------------------------------
	// notify() dispatch: macOS path (current platform)
	// ------------------------------------------------------------------

	describe("notify() dispatch on macOS", () => {
		it.skipIf(process.platform !== "darwin")("uses notifyMacOS on darwin", () => {
			mockedExecFile.mockClear();
			notify("Pi", "Test");
			expect(mockedExecFile).toHaveBeenCalled();
			const [cmd] = mockedExecFile.mock.calls[0];
			expect(["osascript", "terminal-notifier"]).toContain(cmd);
		});
	});

	// ------------------------------------------------------------------
	// Agent integration tests
	// ------------------------------------------------------------------

	describe("agent_end notification", () => {
		it("notifies when agent_end fires and agent is idle", async () => {
			const notifications: Array<{ title: string; body: string }> = [];

			const harness = await createHarness({
				models: [{ id: "faux-1", name: "One", reasoning: false }],
				extensionFactories: [
					(pi) => {
						pi.on("agent_end", async (_event, ctx) => {
							if (ctx.hasPendingMessages()) return;
							notifications.push({ title: "Pi", body: "Done — waiting for input" });
						});
					},
				],
			});
			harnesses.push(harness);

			harness.setResponses([fauxAssistantMessage("Hello, world!")]);
			await harness.session.prompt("Hi");

			expect(notifications).toEqual([{ title: "Pi", body: "Done — waiting for input" }]);
			expect(harness.getPendingResponseCount()).toBe(0);
		});

		it("respects hasPendingMessages() guard in agent_end handler", async () => {
			const notifications: string[] = [];

			const harness = await createHarness({
				models: [{ id: "faux-1", name: "One", reasoning: false }],
				extensionFactories: [
					(pi) => {
						pi.on("agent_end", async (_event, ctx) => {
							if (ctx.hasPendingMessages()) return;
							notifications.push("notified");
						});
					},
				],
			});
			harnesses.push(harness);

			harness.setResponses([fauxAssistantMessage("Hello, world!")]);
			await harness.session.prompt("Hi");

			expect(notifications).toEqual(["notified"]);
		});

		it("fires agent_end event on each completed turn", async () => {
			const agentEndCounts: number[] = [];
			let count = 0;

			const harness = await createHarness({
				models: [{ id: "faux-1", name: "One", reasoning: false }],
				extensionFactories: [
					(pi) => {
						pi.on("agent_end", async (_event, _ctx) => {
							count++;
							agentEndCounts.push(count);
						});
					},
				],
			});
			harnesses.push(harness);

			harness.setResponses([fauxAssistantMessage("First")]);
			await harness.session.prompt("First prompt");
			expect(count).toBe(1);

			harness.setResponses([fauxAssistantMessage("Second")]);
			await harness.session.prompt("Second prompt");
			expect(count).toBe(2);

			expect(agentEndCounts).toEqual([1, 2]);
		});
	});
});
