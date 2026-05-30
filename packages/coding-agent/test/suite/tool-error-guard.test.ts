import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import toolErrorGuardExtension from "../../examples/extensions/tool-error-guard.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("tool-error-guard extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("blocks read on a non-existent file", async () => {
		const harness = await createHarness({
			extensionFactories: [toolErrorGuardExtension],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "/nonexistent/file.txt" })]),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("test");

		const toolEnds = harness.eventsOfType("tool_execution_end");
		expect(toolEnds).toHaveLength(1);
		expect(toolEnds[0].isError).toBe(true);
		expect(toolEnds[0].result.content[0].text).toContain("does not exist");
	});

	it("detects repeated failed read calls on the same path", async () => {
		const harness = await createHarness({
			extensionFactories: [toolErrorGuardExtension],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "/nonexistent/file.txt" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: "/nonexistent/file.txt" })]),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("test");

		const toolEnds = harness.eventsOfType("tool_execution_end");
		expect(toolEnds).toHaveLength(2);
		expect(toolEnds[0].isError).toBe(true);
		expect(toolEnds[0].result.content[0].text).toContain("does not exist");
		expect(toolEnds[1].isError).toBe(true);
		expect(toolEnds[1].result.content[0].text).toContain("Repeated");
	});

	it("rewrites bash error results to suggest path verification", async () => {
		const harness = await createHarness({
			extensionFactories: [toolErrorGuardExtension],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "ls /nonexistent_dir_12345" })]),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("test");

		const toolEnds = harness.eventsOfType("tool_execution_end");
		expect(toolEnds).toHaveLength(1);
		expect(toolEnds[0].isError).toBe(true);
		expect(toolEnds[0].result.content[0].text).toContain("verify the path");
	});

	it("does not block read on an existing file", async () => {
		const harness = await createHarness({
			extensionFactories: [toolErrorGuardExtension],
		});
		harnesses.push(harness);

		const testFile = join(harness.tempDir, "real.txt");
		writeFileSync(testFile, "hello");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: testFile })]),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("test");

		const toolEnds = harness.eventsOfType("tool_execution_end");
		expect(toolEnds).toHaveLength(1);
		expect(toolEnds[0].isError).toBe(false);
	});

	it("blocks edit on a non-existent file", async () => {
		const harness = await createHarness({
			extensionFactories: [toolErrorGuardExtension],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("edit", { path: "/nonexistent/file.txt", edits: [{ oldText: "a", newText: "b" }] }),
			]),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("test");

		const toolEnds = harness.eventsOfType("tool_execution_end");
		expect(toolEnds).toHaveLength(1);
		expect(toolEnds[0].isError).toBe(true);
		expect(toolEnds[0].result.content[0].text).toContain("does not exist");
	});

	it("detects repeated failed edit calls on the same path", async () => {
		const harness = await createHarness({
			extensionFactories: [toolErrorGuardExtension],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("edit", { path: "/nonexistent/file.txt", edits: [{ oldText: "a", newText: "b" }] }),
			]),
			fauxAssistantMessage([
				fauxToolCall("edit", { path: "/nonexistent/file.txt", edits: [{ oldText: "a", newText: "b" }] }),
			]),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("test");

		const toolEnds = harness.eventsOfType("tool_execution_end");
		expect(toolEnds).toHaveLength(2);
		expect(toolEnds[0].isError).toBe(true);
		expect(toolEnds[0].result.content[0].text).toContain("does not exist");
		expect(toolEnds[1].isError).toBe(true);
		expect(toolEnds[1].result.content[0].text).toContain("Repeated");
	});

	it("does not rewrite successful bash results", async () => {
		const harness = await createHarness({
			extensionFactories: [toolErrorGuardExtension],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hello" })]),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("test");

		const toolEnds = harness.eventsOfType("tool_execution_end");
		expect(toolEnds).toHaveLength(1);
		expect(toolEnds[0].isError).toBe(false);
		expect(toolEnds[0].result.content[0].text).toContain("hello");
	});

	it("blocks read with an empty path", async () => {
		const harness = await createHarness({
			extensionFactories: [toolErrorGuardExtension],
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage([fauxToolCall("read", { path: "" })]), fauxAssistantMessage("done")]);

		await harness.session.prompt("test");

		const toolEnds = harness.eventsOfType("tool_execution_end");
		expect(toolEnds).toHaveLength(1);
		expect(toolEnds[0].isError).toBe(true);
		expect(toolEnds[0].result.content[0].text).toContain("empty");
	});

	it("detects repeated failed bash calls on the same command", async () => {
		const harness = await createHarness({
			extensionFactories: [toolErrorGuardExtension],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "ls /nonexistent_dir_12345" })]),
			fauxAssistantMessage([fauxToolCall("bash", { command: "ls /nonexistent_dir_12345" })]),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("test");

		const toolEnds = harness.eventsOfType("tool_execution_end");
		expect(toolEnds).toHaveLength(2);
		expect(toolEnds[0].isError).toBe(true);
		expect(toolEnds[0].result.content[0].text).toContain("verify the path");
		expect(toolEnds[1].isError).toBe(true);
		expect(toolEnds[1].result.content[0].text).toContain("Repeated");
	});

	it("blocks write with an empty path", async () => {
		const harness = await createHarness({
			extensionFactories: [toolErrorGuardExtension],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "", content: "hello" })]),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("test");

		const toolEnds = harness.eventsOfType("tool_execution_end");
		expect(toolEnds).toHaveLength(1);
		expect(toolEnds[0].isError).toBe(true);
		expect(toolEnds[0].result.content[0].text).toContain("empty");
	});

	it("does not block edit on an existing file", async () => {
		const harness = await createHarness({
			extensionFactories: [toolErrorGuardExtension],
		});
		harnesses.push(harness);

		const testFile = join(harness.tempDir, "editme.txt");
		writeFileSync(testFile, "hello world");

		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("edit", { path: testFile, edits: [{ oldText: "hello", newText: "goodbye" }] }),
			]),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("test");

		const toolEnds = harness.eventsOfType("tool_execution_end");
		expect(toolEnds).toHaveLength(1);
		expect(toolEnds[0].isError).toBe(false);
	});
});
