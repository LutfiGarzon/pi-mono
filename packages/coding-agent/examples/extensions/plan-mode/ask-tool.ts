import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Spacer, Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

const askSchema = Type.Object({
	question: Type.String({ description: "The core question or blocker requiring user input" }),
	optionA: Type.String({ description: "The first recommended approach" }),
	optionB: Type.String({ description: "The second recommended approach" }),
});

export type AskToolInput = Static<typeof askSchema>;

function str(value: any): string | null {
	if (value === undefined || value === null) return null;
	return String(value);
}

export function registerAskTool(pi: ExtensionAPI): void {
	pi.registerTool({
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
		renderCall(_args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold("ask")));
			return text;
		},
		renderResult(_result, _options, theme, context) {
			const args = context.args as Partial<AskToolInput> | undefined;
			const question = str(args?.question);
			const optionA = str(args?.optionA);
			const optionB = str(args?.optionB);

			let textStr = "";
			if (question !== null) {
				textStr += theme.fg("accent", question);
			}
			if (optionA !== null) {
				textStr += `\n\n${theme.fg("toolOutput", "Option A: ")}${optionA}`;
			}
			if (optionB !== null) {
				textStr += `\n${theme.fg("toolOutput", "Option B: ")}${optionB}`;
			}

			if (!textStr) {
				return (context.lastComponent as Spacer | undefined) ?? new Spacer(0);
			}
			const textComp = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			textComp.setText(`\n${textStr}`);
			return textComp;
		},
	});
}
