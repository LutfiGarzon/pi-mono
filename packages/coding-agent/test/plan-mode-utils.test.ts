import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { parsePlanFile } from "../examples/extensions/plan-mode/utils.js";

describe("plan-mode utils", () => {
	it("parses markdown checklists correctly", async () => {
		const dir = join(tmpdir(), "pi-plan-test-" + Date.now());
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "plan.md");

		const content = `
# Objective: Refactor

## Tasks
- [ ] Task 1
- [x] Task 2
- [X] Task 3
- [ ] Task 4
		`;
		writeFileSync(file, content);

		const items = await parsePlanFile(file);
		expect(items).toHaveLength(4);
		expect(items[0]).toEqual({ step: 1, text: "Task 1", completed: false });
		expect(items[1]).toEqual({ step: 2, text: "Task 2", completed: true });
		expect(items[2]).toEqual({ step: 3, text: "Task 3", completed: true });
		expect(items[3]).toEqual({ step: 4, text: "Task 4", completed: false });
	});
});
