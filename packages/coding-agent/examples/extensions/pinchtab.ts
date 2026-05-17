import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "child_process";

export default function pinchtabExtension(pi: ExtensionAPI) {
	function runPinchtab(args: string[]): string {
		try {
			// We use PINCHTAB_BROWSER_PATH from the environment if set
			const cmd = `pinchtab ${args.join(" ")}`;
			return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		} catch (error: any) {
			const stderr = error.stderr?.toString() || error.message;
			throw new Error(`PinchTab error: ${stderr}`);
		}
	}

	pi.registerTool({
		name: "browser_open",
		label: "Open Browser",
		description: "Open a URL in the browser",
		parameters: Type.Object({
			url: Type.String({ description: "The URL to open" }),
		}),
		execute: async (_toolCallId: string, { url }: { url: string }) => {
			const result = runPinchtab(["nav", url]);
			return { content: [{ type: "text", text: result }], details: { url } };
		},
	});

	pi.registerTool({
		name: "browser_snapshot",
		label: "Browser Snapshot",
		description: "Get a snapshot of the current page's interactive elements",
		parameters: Type.Object({}),
		execute: async (_toolCallId: string, _params: Record<string, never>) => {
			const result = runPinchtab(["snap", "-i", "-c"]);
			return { content: [{ type: "text", text: result }], details: {} };
		},
	});

	pi.registerTool({
		name: "browser_click",
		label: "Browser Click",
		description: "Click an element by its reference (e.g., e0, e1) from the snapshot",
		parameters: Type.Object({
			ref: Type.String({ description: "The element reference (e.g., e0)" }),
		}),
		execute: async (_toolCallId: string, { ref }: { ref: string }) => {
			const result = runPinchtab(["click", ref]);
			return { content: [{ type: "text", text: result }], details: { ref } };
		},
	});

	pi.registerTool({
		name: "browser_scroll",
		label: "Browser Scroll",
		description: "Scroll to an element or by a number of pixels",
		parameters: Type.Object({
			target: Type.String({ description: "The element reference (e.g., e0) or pixels (e.g., 500)" }),
		}),
		execute: async (_toolCallId: string, { target }: { target: string }) => {
			const result = runPinchtab(["scroll", target]);
			return { content: [{ type: "text", text: result }], details: { target } };
		},
	});

	pi.registerTool({
		name: "browser_type",
		label: "Browser Type",
		description: "Type text into an element",
		parameters: Type.Object({
			ref: Type.String({ description: "The element reference" }),
			text: Type.String({ description: "The text to type" }),
		}),
		execute: async (_toolCallId: string, { ref, text }: { ref: string; text: string }) => {
			// Use 'fill' for direct text entry
			const result = runPinchtab(["fill", ref, `"${text.replace(/"/g, '\\"')}"`]);
			return { content: [{ type: "text", text: result }], details: { ref, text } };
		},
	});

	pi.registerTool({
		name: "browser_press",
		label: "Browser Press",
		description: "Press a key (e.g., Enter, Tab, Escape) on an element",
		parameters: Type.Object({
			ref: Type.String({ description: "The element reference" }),
			key: Type.String({ description: "The key to press (e.g., Enter)" }),
		}),
		execute: async (_toolCallId: string, { ref, key }: { ref: string; key: string }) => {
			const result = runPinchtab(["press", ref, key]);
			return { content: [{ type: "text", text: result }], details: { ref, key } };
		},
	});

	pi.registerTool({
		name: "browser_text",
		label: "Browser Text",
		description: "Extract all text from the current page",
		parameters: Type.Object({}),
		execute: async () => {
			const result = runPinchtab(["text"]);
			return { content: [{ type: "text", text: result }], details: {} };
		},
	});
}
