import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Spacer, Text } from "@earendil-works/pi-tui";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { type Static, Type } from "typebox";

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

function str(value: any): string | null {
	if (value === undefined || value === null) return null;
	return String(value);
}

export function registerPlanTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "plan",
		label: "plan",
		description: "Track objectives and their required tasks using a checklist. Saves to .pi/plan/ directory.",
		promptSnippet: "Track objectives and their required tasks using a checklist",
		parameters: planSchema,
		execute: async (_toolCallId: string, input: PlanToolInput, signal?: AbortSignal, _onUpdate?, ctx?) => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const cwd = ctx?.cwd ?? process.cwd();
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
		renderCall(_args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const args = context.args as Partial<PlanToolInput> | undefined;
			const objective = str(args?.objective);
			const action = str(args?.action);
			const invalidArg = theme.fg("error", "???");

			text.setText(
				theme.fg("toolTitle", theme.bold("plan")) +
					" " +
					(objective === null ? invalidArg : theme.fg("accent", objective)) +
					theme.fg("toolOutput", ` (${action === null ? invalidArg : action})`),
			);
			return text;
		},
		renderResult(_result, options, theme, context) {
			const args = context.args as Partial<PlanToolInput> | undefined;
			const tasks = args?.tasks;
			if (!tasks || !Array.isArray(tasks)) {
				return (context.lastComponent as Spacer | undefined) ?? new Spacer(0);
			}

			const maxTasks = options.expanded ? tasks.length : 5;
			const displayTasks = tasks.slice(0, maxTasks);
			const remaining = tasks.length - maxTasks;

			let textStr = displayTasks
				.map((t) => theme.fg("toolOutput", `${t.status === "completed" ? "[x]" : "[ ]"} ${t.description}`))
				.join("\n");
			if (remaining > 0) {
				textStr += `\n${theme.fg("muted", `... (${remaining} more tasks, <ctrl+o> to expand)`)}`;
			}

			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`\n${textStr}`);
			return text;
		},
	});
}
