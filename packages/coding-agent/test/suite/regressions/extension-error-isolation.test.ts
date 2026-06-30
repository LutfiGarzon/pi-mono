/**
 * Regression tests for the principle that a failing extension must not break
 * the agent: not at load, not at the handler level, and not at the tool-call
 * interception level.
 *
 * The motivating case was the pioneer extension throwing on load when
 * PIONEER_API_KEY was missing — that propagated out of the loader and broke
 * the whole session. The fix was two-fold:
 *
 * 1. The loader already catches factory errors and continues with the other
 *    extensions. These tests pin that behavior so a future refactor cannot
 *    regress it.
 * 2. ExtensionRunner.emitToolCall() previously let handler throws propagate.
 *    The fix wraps each handler in try/catch and routes the error through
 *    emitError, matching the other emit*() methods.
 *
 * The lazy-activation test also pins the working pattern for extensions that
 * need a credential the user does not want to bake into the environment:
 * the extension factory does NOT throw when the credential is missing; it
 * just registers a slash command that calls pi.registerProvider() once the
 * user pastes the key during the session.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { discoverAndLoadExtensions } from "../../../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../../src/core/extensions/runner.ts";
import type { ExtensionUIContext } from "../../../src/core/extensions/types.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { type Theme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Minimal UI context whose `input` returns a fixed key. Matches the
 * ExtensionUIContext shape used elsewhere in the suite.
 */
function makeUiContext(inputResult: string | undefined): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => inputResult,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: (_t: string | Theme) => ({ success: false, error: "not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

describe("extension error isolation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("a throwing tool_call handler does not break tool execution or the agent turn", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text: `echoed:${text}` }], details: { text } };
			},
		};

		const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", () => {
						throw new Error("handler exploded");
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({
			uiContext: makeUiContext(undefined),
			mode: "tui",
			onError: (err) => {
				errors.push({
					extensionPath: err.extensionPath,
					event: err.event,
					error: err.error,
				});
			},
		});

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		// The agent turn must complete; the throwing handler must NOT bubble out.
		await harness.session.prompt("run tool");

		// The tool actually executed, proving the runner did not abort the turn.
		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult).toBeDefined();
		expect(toolResult?.isError).toBeFalsy();

		// The error reached the error listener, consistent with the other emit* methods.
		expect(errors).toHaveLength(1);
		expect(errors[0].event).toBe("tool_call");
		expect(errors[0].error).toContain("handler exploded");
	});

	it("a throwing extension factory does not block the loader or other extensions", async () => {
		// Simulates the old pioneer behavior: throw on load when the required
		// credential is missing. The loader must report it as an error and
		// still load the other extension.
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-iso-test-"));
		const extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);

		// Bad extension: throws on load (simulates API key missing at startup).
		fs.writeFileSync(
			path.join(extensionsDir, "a-bad.ts"),
			`export default function () { throw new Error("API key required"); }\n`,
		);

		// Good extension: registers a tool_call handler. To observe it from
		// the test, the handler writes a marker file the test can read.
		const markerPath = path.join(tempDir, "good-handler-ran.marker");
		fs.writeFileSync(
			path.join(extensionsDir, "b-good.ts"),
			`import * as fs from "node:fs";
import * as path from "node:path";
const marker = ${JSON.stringify(markerPath)};
export default function (pi) {
	pi.on("tool_call", () => {
		fs.writeFileSync(marker, "ok");
	});
}
`,
		);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		// Bad extension is reported, not thrown.
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].path).toContain("a-bad.ts");
		expect(result.errors[0].error).toContain("API key required");

		// Good extension is loaded alongside the failure.
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toContain("b-good.ts");

		// The good extension's handler must still be reachable through the runner.
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage);
		const sessionManager = SessionManager.inMemory();
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

		if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);

		await runner.emitToolCall({
			type: "tool_call",
			toolName: "echo",
			toolCallId: "tc-1",
			input: { text: "hi" },
		});

		expect(fs.existsSync(markerPath)).toBe(true);
		expect(fs.readFileSync(markerPath, "utf-8")).toBe("ok");

		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("supports lazy provider activation: extension loads without the key and registers the provider on /pioneer-api", async () => {
		// The new pioneer pattern: factory must NOT throw when the key is
		// missing. Instead, it registers a slash command that activates the
		// provider when the user pastes the key.
		const PROBE_PROVIDER = "pioneer-probe";

		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					const apiKey = process.env.PIONEER_PROBE_KEY;
					if (apiKey) {
						pi.registerProvider(PROBE_PROVIDER, {
							baseUrl: "https://probe.invalid/v1",
							apiKey,
							api: "openai-completions",
							models: [
								{
									id: "probe-model",
									name: "Probe Model",
									reasoning: false,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 8192,
									maxTokens: 1024,
								},
							],
						});
					}

					pi.registerCommand("pioneer-api", {
						description: "Activate the probe provider by pasting the key",
						handler: async (_args, ctx) => {
							const pasted = await ctx.ui.input("Pioneer probe key", "paste key");
							if (!pasted) {
								ctx.ui.notify("not activated", "warning");
								return;
							}
							pi.registerProvider(PROBE_PROVIDER, {
								baseUrl: "https://probe.invalid/v1",
								apiKey: pasted,
								api: "openai-completions",
								models: [
									{
										id: "probe-model",
										name: "Probe Model",
										reasoning: false,
										input: ["text"],
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
										contextWindow: 8192,
										maxTokens: 1024,
									},
								],
							});
							ctx.ui.notify("activated", "info");
						},
					});
				},
			],
		});
		harnesses.push(harness);

		// Bind with a UI context that returns a key from `input`. `mode: "tui"`
		// also matters because the command path requires an active UI context.
		await harness.session.bindExtensions({
			uiContext: makeUiContext("user-pasted-key"),
			mode: "tui",
		});

		// Before the command, the provider must not be in the registry
		// (PIONEER_PROBE_KEY is not set in the test env).
		expect(harness.session.modelRegistry.find(PROBE_PROVIDER, "probe-model")).toBeUndefined();

		// Run the slash command. The factory did not register the provider
		// (no PIONEER_PROBE_KEY in env), so the command is what activates it.
		await harness.session.prompt("/pioneer-api");

		// After the command, the provider is in the registry.
		const model = harness.session.modelRegistry.find(PROBE_PROVIDER, "probe-model");
		expect(model).toBeDefined();
		expect(model?.baseUrl).toBe("https://probe.invalid/v1");
	});
});
