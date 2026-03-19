import { describe, expect, it } from "vitest";
import { createAskTool } from "../src/core/tools/ask.js";

describe("ask tool", () => {
	it("should return formatted question with options", async () => {
		const tool = createAskTool();
		const result = await tool.execute("test-call-1", {
			question: "How should we proceed?",
			optionA: "Do this",
			optionB: "Do that",
		});

		expect(result.content[0]?.type).toBe("text");
		const text = (result.content[0] as { text: string }).text;

		expect(text).toContain("QUESTION FOR USER:");
		expect(text).toContain("How should we proceed?");
		expect(text).toContain("Option A: Do this");
		expect(text).toContain("Option B: Do that");
		expect(text).toContain("Action Required: The agent is now waiting for the user to reply.");
	});
});
