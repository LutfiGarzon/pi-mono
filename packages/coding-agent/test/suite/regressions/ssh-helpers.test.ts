/**
 * Tests for the SSH remote extension helpers in
 * ~/.pi/agent/extensions/ssh/helpers.ts.
 *
 * These cover the cwd sanitization, round-trip resolve, robust cmd
 * wrapper, and stderr error pattern detection. The point is to lock
 * in the behaviour that prevents a corrupted remoteCwd from breaking
 * every subsequent bash tool call in an SSH session.
 */
import { describe, expect, it } from "vitest";
import {
	buildRemoteCmd,
	detectCwdError,
	resolveRemoteCwd,
	type SshExec,
	sanitizeCwd,
} from "../../../../../../../.pi/agent/extensions/ssh/helpers.ts";

describe("sanitizeCwd", () => {
	it("returns an absolute path unchanged", () => {
		expect(sanitizeCwd("/home/lgarzon-pi")).toBe("/home/lgarzon-pi");
	});

	it("strips leading and trailing whitespace", () => {
		expect(sanitizeCwd("  /home/lgarzon-pi\n")).toBe("/home/lgarzon-pi");
	});

	it("strips leading control characters like ^D (EOT)", () => {
		expect(sanitizeCwd("\u0004/home/lgarzon-pi")).toBe("/home/lgarzon-pi");
	});

	it("strips leading EOT + backspace sequence from script/setsid wrapper", () => {
		// This is the exact pattern from the bug report on the Pi 5 session:
		// `script -q /dev/null` injected "^D\x08\x08" before the actual path.
		expect(sanitizeCwd("^D\u0008\u0008/home/lgarzon-pi")).toBe("/home/lgarzon-pi");
	});

	it("strips leading ^D plus script status line before the path", () => {
		// `script` writes "Script started on <date>\n" to its own stdout;
		// combine that with the detach sequence and we get a messy prefix.
		expect(sanitizeCwd("^D\u0008\u0008Script started on Thu Jul  3 11:38:00 2026\n/home/lgarzon-pi")).toBe(
			"/home/lgarzon-pi",
		);
	});

	it("strips trailing control characters", () => {
		expect(sanitizeCwd("/home/lgarzon-pi\u0004\u0008")).toBe("/home/lgarzon-pi");
	});

	it("strips all C0 control characters (0x00-0x1F) and DEL (0x7F) from edges", () => {
		expect(sanitizeCwd("\u0000\u0001\u0002/home/x\u007f")).toBe("/home/x");
	});

	it("rejects empty input", () => {
		expect(sanitizeCwd("")).toBe("");
		expect(sanitizeCwd("   ")).toBe("");
	});

	it("rejects non-absolute paths (relative paths, tilde, env vars)", () => {
		expect(sanitizeCwd("lgarzon-pi")).toBe("");
		expect(sanitizeCwd("~/foo")).toBe("");
		expect(sanitizeCwd("$HOME")).toBe("");
		expect(sanitizeCwd("C:\\Users\\foo")).toBe("");
	});

	it("rejects paths that still contain control characters after edge stripping", () => {
		expect(sanitizeCwd("/home/\u0004/personal")).toBe("");
	});

	it("handles non-string input defensively", () => {
		expect(sanitizeCwd(undefined as unknown as string)).toBe("");
		expect(sanitizeCwd(null as unknown as string)).toBe("");
		expect(sanitizeCwd(42 as unknown as string)).toBe("");
	});
});

describe("buildRemoteCmd", () => {
	it("wraps the command in a cd with fallbacks", () => {
		const out = buildRemoteCmd("/home/lgarzon-pi", "ls -la");
		// Should start with `(cd "/home/lgarzon-pi" 2>/dev/null || cd $HOME 2>/dev/null || cd /) && `
		// The `$HOME` is escaped (`\$HOME`) so the remote shell expands it
		// and the local JS string interpolation doesn't touch it.
		expect(out).toBe(`(cd "/home/lgarzon-pi" 2>/dev/null || cd \\$HOME 2>/dev/null || cd /) && ls -la`);
	});

	it("escapes the cwd with JSON.stringify to handle special characters", () => {
		const out = buildRemoteCmd("/home/user with space", "echo hi");
		expect(out).toContain('cd "/home/user with space"');
	});

	it("uses / as the target when cwd is empty or invalid", () => {
		// `JSON.stringify("" || "/")` short-circuits to "/", so the first
		// attempt is `cd /` (which always succeeds). The fallback chain is
		// still present as a safety net.
		const out = buildRemoteCmd("", "pwd");
		expect(out).toContain('cd "/" 2>/dev/null');
		expect(out).toContain("|| cd /");
	});

	it("preserves the original command verbatim after `&&`", () => {
		const cmd = "echo 'hello world' && grep -c foo bar.txt | tee /tmp/log";
		const out = buildRemoteCmd("/tmp", cmd);
		expect(out.endsWith(`&& ${cmd}`)).toBe(true);
	});
});

describe("detectCwdError", () => {
	it("returns broken=false for empty input", () => {
		expect(detectCwdError("")).toEqual({ broken: false });
	});

	it("returns broken=false for non-cd error output", () => {
		expect(detectCwdError("ls: cannot access 'foo': No such file or directory")).toEqual({ broken: false });
		expect(detectCwdError("command not found: baz")).toEqual({ broken: false });
	});

	it("detects zsh cd error and extracts the path", () => {
		const stderr = "zsh:cd:1: no such file or directory: /home/lgarzon-pi";
		expect(detectCwdError(stderr)).toEqual({ broken: true, path: "/home/lgarzon-pi" });
	});

	it("detects zsh cd error with the corrupted-cwd pattern from the bug", () => {
		// This is the literal pattern that broke the Pi 5 session.
		const stderr = "zsh:cd:1: no such file or directory: ^D\u0008\u0008/home/lgarzon-pi";
		const result = detectCwdError(stderr);
		expect(result.broken).toBe(true);
		// The captured path includes the control chars; consumers can sanitize it.
		expect((result as { broken: true; path: string }).path).toContain("/home/lgarzon-pi");
	});

	it("detects bash cd error and extracts the path", () => {
		const stderr = "bash: line 1: cd: /some/missing/dir: No such file or directory";
		expect(detectCwdError(stderr)).toEqual({ broken: true, path: "/some/missing/dir" });
	});

	it("works with mixed stdout+stderr input", () => {
		const stderr = "before\nzsh:cd:2: no such file or directory: /var/log/x\nafter";
		expect(detectCwdError(stderr)).toEqual({ broken: true, path: "/var/log/x" });
	});
});

describe("resolveRemoteCwd", () => {
	const fakeExec = (responses: Array<{ match: RegExp | string; out?: string; throw?: Error }>): SshExec => {
		const calls: Array<{ command: string; stdout: string }> = [];
		const fn: SshExec = async (_remote, command) => {
			for (const r of responses) {
				const matches = typeof r.match === "string" ? command === r.match : r.match.test(command);
				if (matches) {
					if (r.throw) throw r.throw;
					const out = r.out ?? "";
					calls.push({ command, stdout: out });
					return Buffer.from(out);
				}
			}
			throw new Error(`fakeExec: no response registered for command: ${command}`);
		};
		(fn as SshExec & { calls: typeof calls }).calls = calls;
		return fn;
	};

	it("returns the captured cwd when round-trip verifies", async () => {
		const exec = fakeExec([
			{ match: /^pwd$/, out: "/home/lgarzon-pi" },
			{ match: /cd .* && pwd/, out: "/home/lgarzon-pi" },
		]);
		expect(await resolveRemoteCwd("u@h", exec)).toBe("/home/lgarzon-pi");
	});

	it("sanitizes the captured cwd before round-trip", async () => {
		// `script -q /dev/null` injects "^D\u0008\u0008" before the path; the
		// resolver must strip that before round-tripping.
		const exec = fakeExec([
			{ match: /^pwd$/, out: "^D\u0008\u0008/home/lgarzon-pi" },
			{ match: /cd .* && pwd/, out: "/home/lgarzon-pi" },
		]);
		expect(await resolveRemoteCwd("u@h", exec)).toBe("/home/lgarzon-pi");
	});

	it("falls back to $HOME when the captured cwd is empty", async () => {
		const exec = fakeExec([
			{ match: /^pwd$/, out: "^D\u0008\u0008" },
			{ match: /HOME/, out: "/home/lgarzon-pi" },
		]);
		expect(await resolveRemoteCwd("u@h", exec)).toBe("/home/lgarzon-pi");
	});

	it("falls back to $HOME when round-trip fails", async () => {
		const exec = fakeExec([
			{ match: /^pwd$/, out: "/tmp/nowhere" },
			{ match: /cd .* && pwd/, throw: new Error("cd failed") },
			{ match: /HOME/, out: "/home/lgarzon-pi" },
		]);
		expect(await resolveRemoteCwd("u@h", exec)).toBe("/home/lgarzon-pi");
	});

	it("falls back to $HOME when the round-trip path doesn't match the captured one", async () => {
		// Captured says /a, but `cd /a && pwd` returns /b (symlink resolution).
		// We can't trust the captured value, so fall back to $HOME.
		const exec = fakeExec([
			{ match: /^pwd$/, out: "/a" },
			{ match: /cd .* && pwd/, out: "/b" },
			{ match: /HOME/, out: "/home/lgarzon-pi" },
		]);
		expect(await resolveRemoteCwd("u@h", exec)).toBe("/home/lgarzon-pi");
	});

	it("falls back to / when both pwd and $HOME fail", async () => {
		const exec = fakeExec([
			{ match: /^pwd$/, throw: new Error("connection lost") },
			{ match: /HOME/, throw: new Error("connection lost") },
		]);
		expect(await resolveRemoteCwd("u@h", exec)).toBe("/");
	});

	it("passes identityFile/pass/port through to exec", async () => {
		const seenOpts: Array<unknown> = [];
		const exec: SshExec = async (_r, _c, opts) => {
			seenOpts.push(opts);
			return Buffer.from("/home/lgarzon-pi");
		};
		await resolveRemoteCwd("u@h", exec, { identityFile: "/tmp/k", pass: "secret", port: 2222 });
		expect(seenOpts[0]).toEqual({ identityFile: "/tmp/k", pass: "secret", port: 2222 });
	});

	it("never throws", async () => {
		const exec: SshExec = async () => {
			throw new Error("total failure");
		};
		// Should resolve to "/" via the fallback path, not reject.
		await expect(resolveRemoteCwd("u@h", exec)).resolves.toBe("/");
	});
});
