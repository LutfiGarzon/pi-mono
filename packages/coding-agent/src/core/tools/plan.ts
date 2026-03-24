import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Spacer, Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { theme } from "../../modes/interactive/theme/theme.js";
import type { ToolDefinition } from "../extensions/types.js";
import { invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const planTaskSchema = Type.Object({
	description: Type.String({ description: "The task description" }),
	status: Type.Union([Type.Literal("pending"), Type.Literal("completed")]),
});

const planSchema = Type.Object({
	objective: Type.String({ description: "A short, hyphenated string describing the goal (used for filename)" }),
	tasks: Type.Array(planTaskSchema, { description: "The list of tasks required to complete the objective" }),
	action: Type.Union([Type.Literal("create"), Type.Literal("update")], {
		description: "Whether to create a new plan or update an existing one",
	}),
});

export type PlanToolInput = Static<typeof planSchema>;

function getFormattedDate(): string {
	const now = new Date();
	const mm = String(now.getMonth() + 1).padStart(2, "0");
	const dd = String(now.getDate()).padStart(2, "0");
	const yyyy = now.getFullYear();
	return `${mm}-${dd}-${yyyy}`;
}

function generateMarkdown(objective: string, tasks: Static<typeof planTaskSchema>[]): string {
	let md = `# Objective: ${objective}\n\n## Tasks\n`;
	for (const task of tasks) {
		const check = task.status === "completed" ? "[x]" : "[ ]";
		md += `- ${check} ${task.description}\n`;
	}
	return md;
}

function formatPlanCall(args: Partial<PlanToolInput> | undefined): string {
	const objective = str(args?.objective);
	const action = str(args?.action);
	const invalidArg = invalidArgText(theme);

	return (
		theme.fg("toolTitle", theme.bold("plan")) +
		" " +
		(objective === null ? invalidArg : theme.fg("accent", objective)) +
		theme.fg("toolOutput", ` (${action === null ? invalidArg : action})`)
	);
}

function formatPlanResult(args: Partial<PlanToolInput> | undefined, expanded: boolean): string {
	const tasks = args?.tasks;
	if (!tasks || !Array.isArray(tasks)) return "";

	const maxTasks = expanded ? tasks.length : 5;
	const displayTasks = tasks.slice(0, maxTasks);
	const remaining = tasks.length - maxTasks;

	let text = displayTasks
		.map((t) => theme.fg("toolOutput", `${t.status === "completed" ? "[x]" : "[ ]"} ${t.description}`))
		.join("\n");
	if (remaining > 0) {
		text += `\n${theme.fg("muted", `... (${remaining} more tasks,`)} ${keyHint("app.tools.expand", "to expand")})`;
	}
	return text;
}

export function createPlanToolDefinition(cwd: string): ToolDefinition<typeof planSchema, undefined> {
	return {
		name: "plan",
		label: "plan",
		description: "Track objectives and their required tasks using a checklist. Saves to .pi/plan/ directory.",
		promptSnippet: "Track objectives and their required tasks using a checklist",
		parameters: planSchema,
		execute: async (_toolCallId: string, input: PlanToolInput, signal?: AbortSignal) => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const planDir = path.join(cwd, ".pi", "plan");
			await mkdir(planDir, { recursive: true });

			const dateStr = getFormattedDate();
			// Sanitize objective for filename
			const safeObjective = input.objective.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
			const filename = `${dateStr}-${safeObjective}.md`;
			const filepath = path.join(planDir, filename);

			const markdownContent = generateMarkdown(input.objective, input.tasks);

			await writeFile(filepath, markdownContent, "utf-8");

			return {
				content: [
					{
						type: "text",
						text: `Plan successfully ${input.action}d at ${filepath}\n\nCurrent Plan:\n${markdownContent}`,
					},
				],
				details: undefined,
			};
		},
		renderCall(args, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatPlanCall(args));
			return text;
		},
		renderResult(_result, options, _theme, context) {
			const output = formatPlanResult(context.args, options.expanded);
			if (!output) {
				return (context.lastComponent as Spacer | undefined) ?? new Spacer(0);
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`\n${output}`);
			return text;
		},
	};
}

export function createPlanTool(cwd: string): AgentTool<typeof planSchema> {
	return wrapToolDefinition(createPlanToolDefinition(cwd));
}

export const planToolDefinition = createPlanToolDefinition(process.cwd());
export const planTool = createPlanTool(process.cwd());
