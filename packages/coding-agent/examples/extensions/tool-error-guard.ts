import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

function callSignature(toolName: string, args: unknown): string {
	return `${toolName}:${JSON.stringify(args)}`;
}

function checkFileExists(toolName: string, path: string, cwd: string, failedCalls: Set<string>) {
	if (!path || path.trim().length === 0) {
		return { block: true, reason: `Path is empty. Provide a valid file path for ${toolName}.` };
	}
	const absolutePath = resolve(cwd, path);
	const signature = callSignature(toolName, { path });
	if (!existsSync(absolutePath)) {
		if (failedCalls.has(signature)) {
			return {
				block: true,
				reason: `Repeated failed call: ${toolName} ${path}. The file still does not exist. Use ls or bash to explore the directory.`,
			};
		}
		failedCalls.add(signature);
		return { block: true, reason: `File does not exist: ${path}` };
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	const failedCalls = new Set<string>();

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("read", event)) {
			const result = checkFileExists("read", event.input.path, ctx.cwd, failedCalls);
			if (result) return result;
		}
		if (isToolCallEventType("edit", event)) {
			const result = checkFileExists("edit", event.input.path, ctx.cwd, failedCalls);
			if (result) return result;
		}
		if (isToolCallEventType("write", event)) {
			if (!event.input.path || event.input.path.trim().length === 0) {
				return { block: true, reason: "Path is empty. Provide a valid file path for write." };
			}
		}
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command;
			const signature = callSignature("bash", { command });
			if (failedCalls.has(signature)) {
				return {
					block: true,
					reason: `Repeated failed call: bash "${command}". This command already failed. Fix the issue before retrying.`,
				};
			}
		}
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName === "bash" && event.isError) {
			const command = (event.input as { command?: string }).command ?? "";
			const signature = callSignature("bash", { command });
			const isRepeated = failedCalls.has(signature);
			failedCalls.add(signature);
			const originalText = event.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			if (originalText.includes("Command exited with code")) {
				const prefix = isRepeated
					? "[tool error] Repeated failed bash command."
					: "[tool error] The bash command failed. Before running commands, verify the path exists and the syntax is correct.";
				return {
					content: [
						{
							type: "text",
							text: `${prefix}\n\nOriginal output:\n${originalText}`,
						},
					],
				};
			}
		}
		return undefined;
	});
}
