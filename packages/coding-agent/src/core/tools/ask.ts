import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Spacer, Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { theme } from "../../modes/interactive/theme/theme.js";
import type { ToolDefinition } from "../extensions/types.js";
import { str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const askSchema = Type.Object({
	question: Type.String({ description: "The core question or blocker requiring user input" }),
	optionA: Type.String({ description: "The first recommended approach" }),
	optionB: Type.String({ description: "The second recommended approach" }),
});

export type AskToolInput = Static<typeof askSchema>;

function formatAskCall(): string {
	return theme.fg("toolTitle", theme.bold("ask"));
}

function formatAskResult(args: Partial<AskToolInput> | undefined): string {
	const question = str(args?.question);
	const optionA = str(args?.optionA);
	const optionB = str(args?.optionB);

	let text = "";
	if (question !== null) {
		text += theme.fg("accent", question);
	}
	if (optionA !== null) {
		text += `\n\n${theme.fg("toolOutput", "Option A: ")}${optionA}`;
	}
	if (optionB !== null) {
		text += `\n${theme.fg("toolOutput", "Option B: ")}${optionB}`;
	}
	return text;
}

export function createAskToolDefinition(): ToolDefinition<typeof askSchema, undefined> {
	return {
		name: "ask",
		label: "ask",
		description:
			"Explicitly pause and ask the user for direction or clarification. Provides two recommended options, but informs the user they can choose a third option or reframe the request.",
		promptSnippet: "Pause and ask the user for direction or clarification",
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
		renderCall(_args, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatAskCall());
			return text;
		},
		renderResult(_result, _options, _theme, context) {
			const output = formatAskResult(context.args);
			if (!output) {
				return (context.lastComponent as Spacer | undefined) ?? new Spacer(0);
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`\n${output}`);
			return text;
		},
	};
}

export function createAskTool(): AgentTool<typeof askSchema> {
	return wrapToolDefinition(createAskToolDefinition());
}

export const askToolDefinition = createAskToolDefinition();
export const askTool = createAskTool();
