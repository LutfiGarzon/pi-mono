import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlanTool } from "../src/core/tools/plan.js";

describe("plan tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-plan-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should create a plan file and directories", async () => {
		const tool = createPlanTool(testDir);
		const result = await tool.execute("test-call-1", {
			objective: "Test objective with spaces!",
			tasks: [
				{ description: "Task 1", status: "pending" },
				{ description: "Task 2", status: "completed" },
			],
			action: "create",
		});

		expect(result.content[0]?.type).toBe("text");
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Plan successfully created at");

		const planDir = join(testDir, ".pi", "plan");
		expect(statSync(planDir).isDirectory()).toBe(true);

		const files = readdirSync(planDir);
		expect(files.length).toBe(1);
		expect(files[0]).toContain("test-objective-with-spaces-");

		const content = readFileSync(join(planDir, files[0]!), "utf-8");
		expect(content).toContain("# Objective: Test objective with spaces!");
		expect(content).toContain("- [ ] Task 1");
		expect(content).toContain("- [x] Task 2");
	});
});
