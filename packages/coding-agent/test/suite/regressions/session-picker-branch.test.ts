/**
 * Regression: the `pi -r` session picker only shows the initial prompt, so sessions
 * started on the same folder but on different git branches are hard to tell apart.
 *
 * The fix records the git branch on the session header at creation time and exposes
 * it on SessionInfo so the picker can render it as a second line.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getGitBranch, type SessionHeader, SessionManager } from "../../../src/core/session-manager.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}\n${result.stderr}`);
	}
	return result.stdout.trim();
}

function initGitRepo(repoDir: string, branch: string): void {
	git(["init", `--initial-branch=${branch}`], repoDir);
	git(["config", "--local", "user.email", "test@test.com"], repoDir);
	git(["config", "--local", "user.name", "Test"], repoDir);
	// Detached init on some systems leaves no commit; create an empty initial commit.
	git(["commit", "--allow-empty", "-m", "init"], repoDir);
}

function makeTempDir(prefix: string): string {
	const dir = join(tmpdir(), `pi-branch-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("session picker branch metadata", () => {
	beforeAll(() => initTheme("dark"));

	const tempDirs: string[] = [];
	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop()!;
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("getGitBranch returns undefined for non-git directories", () => {
		const dir = makeTempDir("no-git");
		tempDirs.push(dir);
		expect(getGitBranch(dir)).toBeUndefined();
	});

	it("getGitBranch returns the current branch in a git repo", () => {
		const dir = makeTempDir("main");
		tempDirs.push(dir);
		initGitRepo(dir, "main");
		expect(getGitBranch(dir)).toBe("main");

		// Switch branches and confirm the helper re-reads HEAD.
		git(["checkout", "-b", "feature/foo"], dir);
		expect(getGitBranch(dir)).toBe("feature/foo");
	});

	it("getGitBranch returns undefined when HEAD is detached", () => {
		const dir = makeTempDir("detached");
		tempDirs.push(dir);
		initGitRepo(dir, "main");
		const sha = git(["rev-parse", "HEAD"], dir);
		git(["checkout", "--detach", sha], dir);
		expect(getGitBranch(dir)).toBeUndefined();
	});

	it("SessionManager.newSession records the current branch in the header", () => {
		const dir = makeTempDir("record");
		tempDirs.push(dir);
		initGitRepo(dir, "feat/branch-picker");

		const sessionDir = join(dir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const mgr = SessionManager.create(dir, sessionDir);
		const file = mgr.getSessionFile();
		expect(file).toBeDefined();
		mgr.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		// Re-open and inspect the on-disk header.
		const reopened = SessionManager.open(file!);
		const header = reopened.getHeader();
		expect(header).not.toBeNull();
		expect(header!.branch).toBe("feat/branch-picker");
	});

	it("SessionInfo exposes the branch recorded in the header", async () => {
		const dir = makeTempDir("info");
		tempDirs.push(dir);
		initGitRepo(dir, "info-branch");

		const sessionDir = join(dir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const mgr = SessionManager.create(dir, sessionDir);
		mgr.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const sessions = await SessionManager.list(dir, sessionDir);
		const ours = sessions.find((s) => s.path === mgr.getSessionFile());
		expect(ours).toBeDefined();
		expect(ours!.branch).toBe("info-branch");
	});

	it("headers from older session files (no branch field) still parse", () => {
		// Mimic a v3 session file written before the branch field existed.
		const dir = makeTempDir("legacy");
		tempDirs.push(dir);
		const sessionDir = join(dir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const file = join(sessionDir, "legacy.jsonl");
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: "legacy-id",
			timestamp: new Date().toISOString(),
			cwd: dir,
		};
		writeFileSync(file, `${JSON.stringify(header)}\n`, "utf8");

		const mgr = SessionManager.open(file);
		expect(mgr.getHeader()?.branch).toBeUndefined();
	});
});
