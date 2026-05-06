/**
 * Pi Smart Notify Extension
 *
 * Sends a native system notification when Pi is done working and waiting for input.
 *
 * Two modes:
 * - Static: "Done — waiting for input" (always works, no API key needed)
 * - Smart: Uses a cheap LLM to generate creative short notifications with personality
 *
 * Supported models: Gemini 3.1 Flash Lite (thinking=off)
 *
 * Commands:
 * - /notify-settings: Configure smart notifications, personality, and model
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { completeSimple, getEnvApiKey, getModel } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Notification icon (optional, macOS only)
// ---------------------------------------------------------------------------

const NOTIFICATION_ICON = "/Users/lgarzon/Downloads/favicon.svg";

function hasTerminalNotifier(): boolean {
	try {
		const { execSync } = require("node:child_process");
		execSync("which terminal-notifier", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Personalities
// ---------------------------------------------------------------------------

interface Personality {
	id: string;
	label: string;
	systemPrompt: string;
}

const PERSONALITIES: Personality[] = [
	{
		id: "random",
		label: "Random",
		systemPrompt:
			"You are a notification generator. Pick a random fun personality each time. Generate a single notification message (under 30 characters) telling me the coding agent finished its work. Be punchy and creative. Return ONLY the message text, nothing else.",
	},
	{
		id: "pirate",
		label: "Pirate",
		systemPrompt:
			"You are a pirate notification generator. Generate a single notification message (under 30 characters) in pirate speak telling me the coding agent be done with its work. Return ONLY the message text, nothing else.",
	},
	{
		id: "butler",
		label: "Butler",
		systemPrompt:
			"You are a formal butler notification generator. Generate a single notification message (under 30 characters) in refined butler style informing me the coding agent has completed its task. Return ONLY the message text, nothing else.",
	},
	{
		id: "sarcastic",
		label: "Sarcastic",
		systemPrompt:
			"You are a sarcastic notification generator. Generate a single notification message (under 30 characters) with a sarcastic, witty tone telling me the coding agent actually finished something. Return ONLY the message text, nothing else.",
	},
	{
		id: "zen",
		label: "Zen Master",
		systemPrompt:
			"You are a zen master notification generator. Generate a single notification message (under 30 characters) in calm, zen-like wisdom telling me the coding agent's work is complete. Return ONLY the message text, nothing else.",
	},
	{
		id: "hacker",
		label: "Hacker",
		systemPrompt:
			"You are a hacker/coding notification generator. Generate a single notification message (under 30 characters) in elite hacker style telling me the operation completed. Return ONLY the message text, nothing else.",
	},
	{
		id: "cowboy",
		label: "Cowboy",
		systemPrompt:
			"You are a cowboy notification generator. Generate a single notification message (under 30 characters) in wild west cowboy style telling me the coding agent finished its job. Return ONLY the message text, nothing else.",
	},
];

export function getPersonality(id: string): Personality {
	const found = PERSONALITIES.find((p) => p.id === id);
	return found ?? PERSONALITIES[0];
}

export function pickPersonality(preferredId: string): Personality {
	if (preferredId === "random") {
		const nonRandom = PERSONALITIES.filter((p) => p.id !== "random");
		return nonRandom[Math.floor(Math.random() * nonRandom.length)];
	}
	return getPersonality(preferredId);
}

// ---------------------------------------------------------------------------
// Model options
// ---------------------------------------------------------------------------

interface ModelOption {
	id: string;
	label: string;
	providerKey: string;
}

const MODEL_OPTIONS: ModelOption[] = [
	{
		id: "gemini-3.1-flash-lite-preview",
		label: "Gemini 3.1 Flash Lite",
		providerKey: "google",
	},
];

function modelOptionKey(opt: ModelOption): string {
	return `${opt.id}@${opt.providerKey}`;
}

export function getModelOption(key: string): ModelOption | undefined {
	return MODEL_OPTIONS.find((m) => modelOptionKey(m) === key);
}

function envVarForProvider(provider: string): string {
	const map: Record<string, string> = {
		google: "GEMINI_API_KEY",
	};
	return map[provider] ?? "";
}

// ---------------------------------------------------------------------------
// Settings persistence (file-based, survives sessions)
// ---------------------------------------------------------------------------

interface NotifySettings {
	smartEnabled: boolean;
	personalityId: string;
	modelKey: string;
}

const DEFAULT_SETTINGS: NotifySettings = {
	smartEnabled: false,
	personalityId: "random",
	modelKey: "gemini-3.1-flash-lite-preview@google",
};

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "notify-settings.json");

function loadSettings(): NotifySettings {
	try {
		if (existsSync(SETTINGS_PATH)) {
			const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
			return { ...DEFAULT_SETTINGS, ...raw };
		}
	} catch {
		// Corrupted file, fall through to defaults
	}
	return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings: NotifySettings): void {
	try {
		writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
	} catch {
		// Ignore write errors
	}
}

// ---------------------------------------------------------------------------
// Notification functions
// ---------------------------------------------------------------------------

export function notifyMacOS(title: string, body: string): void {
	if (hasTerminalNotifier()) {
		const args = ["-title", title, "-message", body, "-sender", "com.apple.Terminal"];
		if (existsSync(NOTIFICATION_ICON)) {
			args.push("-appIcon", NOTIFICATION_ICON);
		}
		execFile("terminal-notifier", args);
		return;
	}

	const escapedBody = body.replace(/"/g, '\\"');
	const escapedTitle = title.replace(/"/g, '\\"');
	execFile("osascript", ["-e", `display notification "${escapedBody}" with title "${escapedTitle}"`]);
}

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
}

export function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

export function notifyOSC99(title: string, body: string): void {
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

export function notifyWindows(title: string, body: string): void {
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

export function notify(title: string, body: string): void {
	if (process.platform === "darwin") {
		notifyMacOS(title, body);
	} else if (process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
	} else {
		notifyOSC777(title, body);
	}
}

// ---------------------------------------------------------------------------
// Smart notification: LLM-generated message
// ---------------------------------------------------------------------------

/** Extract text from the model response. */
function extractResponseText(result: any): string | null {
	const textBlock = result.content.find((c: any) => c.type === "text");
	if (textBlock?.text) {
		return textBlock.text.trim().slice(0, 30);
	}
	return null;
}

async function generateSmartMessage(
	personality: Personality,
	modelOption: ModelOption,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal?: AbortSignal,
): Promise<string | null> {
	if (!apiKey) return null;

	try {
		const model = getModel(modelOption.providerKey as any, modelOption.id as any);
		if (!model) return null;

		const result = await completeSimple(
			model,
			{
				systemPrompt: personality.systemPrompt,
				messages: [
					{
						role: "user",
						content: "Generate a notification.",
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey,
				headers,
				maxTokens: 30,
				temperature: 0.9,
				signal,
			},
		);

		return extractResponseText(result);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let settings = loadSettings();

	pi.on("session_start", () => {
		settings = loadSettings();
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.hasPendingMessages()) return;

		if (settings.smartEnabled) {
			const modelOption = getModelOption(settings.modelKey);
			if (modelOption) {
				const model = getModel(modelOption.providerKey as any, modelOption.id as any);
				if (model) {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
					if (auth.ok) {
						const apiKey =
							auth.apiKey ??
							getEnvApiKey(modelOption.providerKey) ??
							process.env[envVarForProvider(modelOption.providerKey)];
						if (apiKey) {
							const personality = pickPersonality(settings.personalityId);
							const message = await generateSmartMessage(
								personality,
								modelOption,
								apiKey,
								auth.ok ? (auth as any).headers : undefined,
								ctx.signal,
							);
							if (message) {
								notify("Pi", message);
								return;
							}
						}
					}
				}
			}
		}

		notify("Pi", "Done — waiting for input");
	});

	// -----------------------------------------------------------------------
	// /notify-settings command
	// -----------------------------------------------------------------------

	pi.registerCommand("notify-settings", {
		description: "Configure notification settings (smart mode, personality, model)",
		handler: async (_args, ctx) => {
			settings = loadSettings();

			while (true) {
				const smartLabel = settings.smartEnabled ? "Smart Notifications: ON" : "Smart Notifications: OFF";
				const personality = getPersonality(settings.personalityId);
				const personalityLabel = `Personality: ${personality.label}`;
				const modelOption = getModelOption(settings.modelKey) ?? MODEL_OPTIONS[0];
				const modelLabel = `Model: ${modelOption.label}`;

				let keyStatus = " (no key)";
				try {
					const model = getModel(modelOption.providerKey as any, modelOption.id as any);
					if (model) {
						const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
						if (auth.ok && (auth as any).apiKey) keyStatus = " (key set)";
					}
				} catch {
					// Ignore
				}
				if (keyStatus === " (no key)") {
					const envKey =
						getEnvApiKey(modelOption.providerKey) ?? process.env[envVarForProvider(modelOption.providerKey)];
					if (envKey) keyStatus = " (key set)";
				}

				const choice = await ctx.ui.select("Notification Settings", [
					smartLabel,
					personalityLabel,
					`${modelLabel}${keyStatus}`,
					"Done",
				]);

				if (choice === undefined || choice === "Done") break;

				if (choice === smartLabel) {
					const enable = await ctx.ui.confirm(
						"Smart Notifications",
						"Enable AI-generated notification messages? Uses your configured API key.",
					);
					if (enable !== undefined) {
						settings.smartEnabled = enable;
						saveSettings(settings);
					}
				} else if (choice === personalityLabel) {
					const options = PERSONALITIES.map((p) => p.label);
					const selected = await ctx.ui.select("Choose Personality", options);
					if (selected !== undefined) {
						const picked = PERSONALITIES.find((p) => p.label === selected);
						if (picked) {
							settings.personalityId = picked.id;
							saveSettings(settings);
						}
					}
				} else if (choice?.startsWith("Model:")) {
					const options = MODEL_OPTIONS.map((m) => m.label);
					const selected = await ctx.ui.select("Choose Model", options);
					if (selected !== undefined) {
						const picked = MODEL_OPTIONS.find((m) => m.label === selected);
						if (picked) {
							settings.modelKey = modelOptionKey(picked);
							saveSettings(settings);
						}
					}
				}
			}
		},
	});
}
