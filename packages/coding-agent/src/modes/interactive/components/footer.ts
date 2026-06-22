import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}
	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}
	invalidate(): void {}
	dispose(): void {}

	render(width: number): string[] {
		const state = this.session.state;

		let totalInput = 0,
			totalOutput = 0,
			totalCacheRead = 0,
			totalCacheWrite = 0,
			totalCost = 0;
		let latestCacheHitRate: number | undefined;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			}
		}

		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// ── Line 1: pwd + branch + session | extension statuses ──
		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
		const branch = this.footerData.getGitBranch();
		if (branch) pwd = `${pwd} (${branch})`;
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) pwd = `${pwd} • ${sessionName}`;

		let extStatusText = "";
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			extStatusText = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text))
				.join("  ");
		}

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

		let line1 = pwdLine;
		if (extStatusText) {
			const extW = visibleWidth(extStatusText);
			const pwdW = visibleWidth(pwdLine);
			const gap = width - pwdW - extW;
			if (gap >= 2) line1 = pwdLine + " ".repeat(gap) + extStatusText;
		}

		// ── Line 2: token stats (left) | model + thinking (right) ──
		const statsParts = [];
		if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
		if ((totalCacheRead > 0 || totalCacheWrite > 0) && latestCacheHitRate !== undefined)
			statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);

		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		if (totalCost || usingSubscription)
			statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);

		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const ctxDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) contextPercentStr = theme.fg("error", ctxDisplay);
		else if (contextPercentValue > 70) contextPercentStr = theme.fg("warning", ctxDisplay);
		else contextPercentStr = ctxDisplay;
		statsParts.push(contextPercentStr);

		if (areExperimentalFeaturesEnabled())
			statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);

		let statsLeft = statsParts.join(" ");
		let statsLeftWidth = visibleWidth(statsLeft);
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		const modelName = state.model?.id || "no-model";
		const minPadding = 2;

		let rightSide = modelName;
		if (state.model?.reasoning) {
			const tl = state.thinkingLevel || "off";
			rightSide = tl === "off" ? `${modelName} • thinking off` : `${modelName} • ${tl}`;
		}
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			const withProvider = `(${state.model!.provider}) ${rightSide}`;
			if (statsLeftWidth + minPadding + visibleWidth(withProvider) <= width) rightSide = withProvider;
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
		} else {
			const avail = width - statsLeftWidth - minPadding;
			if (avail > 0) {
				const tr = truncateToWidth(rightSide, avail, "");
				statsLine = statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(tr))) + tr;
			} else {
				statsLine = statsLeft;
			}
		}

		const dimStatsLeft = theme.fg("dim", statsLeft);
		const dimRemainder = theme.fg("dim", statsLine.slice(statsLeft.length));

		return [line1, dimStatsLeft + dimRemainder];
	}
}
