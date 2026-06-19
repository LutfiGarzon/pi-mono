import { AgentHarness } from "./agent-harness.ts";
import { Session } from "./session/session.ts";
import type { AgentHarnessOptions, SessionMetadata, SessionStorage } from "./types.ts";

export function createSession<TMetadata extends SessionMetadata>(
	storage: SessionStorage<TMetadata>,
): Session<TMetadata> {
	return new Session(storage);
}

export function createAgentHarness(options: AgentHarnessOptions): AgentHarness {
	return new AgentHarness(options);
}
