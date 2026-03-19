import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";

const askSchema = Type.Object({
	question: Type.String({ description: "The core question or blocker requiring user input" }),
	optionA: Type.String({ description: "The first recommended approach" }),
	optionB: Type.String({ description: "The second recommended approach" }),
});

export type AskToolInput = Static<typeof askSchema>;

export function createAskTool(): AgentTool<typeof askSchema> {
	return {
		name: "ask",
		label: "ask",
		description:
			"Explicitly pause and ask the user for direction or clarification. Provides two recommended options, but informs the user they can choose a third option or reframe the request.",
		parameters: askSchema,
		execute: async (_toolCallId: string, input: AskToolInput, signal?: AbortSignal) => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const formattedMessage = `QUESTION FOR USER:
${input.question}

Option A: ${input.optionA}
Option B: ${input.optionB}

(Note to user: You can choose A, choose B, provide a third alternative, or completely reframe the request if these options are insufficient.)

---
Action Required: The agent is now waiting for the user to reply. Stop tool execution.`;

			return {
				content: [{ type: "text", text: formattedMessage }],
				details: undefined,
			};
		},
	};
}

export const askTool = createAskTool();
