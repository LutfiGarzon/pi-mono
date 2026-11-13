import { describe, expect, it } from "vitest";
import { buildCatalog } from "../catalog/build.ts";
import codex from "../catalog/providers/openai-codex.ts";
import type { CatalogSources } from "../catalog/sources/index.ts";

const sources: CatalogSources = {
	modelsDev: {},
	modelsDevDecisions: {},
	openRouter: { chat: [], images: [], classifiers: [] },
	aiGateway: { chat: [], classifiers: [] },
	nvidiaModelIds: new Map(),
	radius: [],
};

describe("OpenAI Codex catalog", () => {
	it("preserves the fork's older models alongside upstream models", () => {
		const models = buildCatalog([codex], sources, true)["openai-codex"].chat;
		expect(models.map((model) => model.id)).toEqual(
			expect.arrayContaining([
				"gpt-5.3-codex-spark",
				"gpt-5.4",
				"gpt-5.4-mini",
				"gpt-5.5",
				"gpt-6.1-sol",
				"gpt-6.1-terra",
			]),
		);
		const spark = models.find((model) => model.id === "gpt-5.3-codex-spark");
		expect(spark).toMatchObject({
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 128000,
			cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
			thinkingLevelMap: { minimal: "low", xhigh: "xhigh" },
		});
		expect(spark?.inputLimits).toBeUndefined();
		const gpt54 = models.find((model) => model.id === "gpt-5.4");
		expect(gpt54).toMatchObject({
			input: ["text", "image"],
			contextWindow: 272000,
			cost: {
				input: 2.5,
				output: 15,
				tiers: [{ inputTokensAbove: 272000, input: 5, output: 22.5 }],
			},
			compat: { supportsOpenAIGrammarTools: true, supportsMidConvoSystemMessages: true },
		});
		expect(gpt54?.compat).not.toHaveProperty("supportsToolSearch");
		expect(models.find((model) => model.id === "gpt-6.1-sol")).toMatchObject({
			contextWindow: 500000,
			compat: { supportsToolSearch: true, supportsAdditionalTools: true },
		});
	});
});
