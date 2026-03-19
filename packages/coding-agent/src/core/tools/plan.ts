import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

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

export function createPlanTool(cwd: string): AgentTool<typeof planSchema> {
	return {
		name: "plan",
		label: "plan",
		description: "Track objectives and their required tasks using a checklist. Saves to .pi/plan/ directory.",
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
	};
}

export const planTool = createPlanTool(process.cwd());
