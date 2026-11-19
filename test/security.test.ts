import { test } from "node:test";
import assert from "node:assert/strict";
import {
	SecretRegistry,
	authConfigured,
	describeCapabilities,
	filterToolNames,
	matchToolName,
	parseCapabilities,
	resolveSecretRefs,
	signChannelBody,
	verifyChannelRequest,
} from "../src/security.ts";
import { resolveInsideRoot } from "../src/codemode.ts";

test("redaction: known secrets are replaced, short values are left alone", () => {
	const registry = new SecretRegistry();
	registry.add("GITHUB_TOKEN", "ghp_supersecretvalue");
	registry.add("TINY", "abc");

	const out = registry.redact("token=ghp_supersecretvalue and abc");
	assert.match(out, /«redacted:GITHUB_TOKEN»/);
	assert.match(out, /and abc$/, "short values are not redacted");
});

test("redaction: the longest matching secret wins", () => {
	const registry = new SecretRegistry();
	registry.add("SHORT", "abcdefghij");
	registry.add("LONG", "abcdefghij-klmnop");
	assert.equal(registry.redact("abcdefghij-klmnop"), "«redacted:LONG»");
});

test("redaction: env discovery only picks secret-shaped names", () => {
	const registry = new SecretRegistry();
	registry.addFromEnv({
		OPENROUTER_API_KEY: "sk-or-verysecret",
		GITHUB_TOKEN: "ghp_anothersecret",
		HOME: "/Users/somebody",
		DEBUG: "1",
	});
	assert.equal(registry.size, 2);
	assert.match(registry.redact("sk-or-verysecret"), /redacted/);
	assert.equal(registry.redact("/Users/somebody"), "/Users/somebody");
});

test("resolveSecretRefs: ${env:NAME} placeholders resolve at use time", () => {
	process.env.MIR_TEST_TOKEN = "resolved-value";
	const resolved = resolveSecretRefs({
		headers: { Authorization: "Bearer ${env:MIR_TEST_TOKEN}" },
		plain: "${env:MIR_TEST_TOKEN}",
		nested: [{ token: "${env:DOES_NOT_EXIST}" }],
	});
	assert.deepEqual(resolved, {
		headers: { Authorization: "Bearer resolved-value" },
		plain: "resolved-value",
		nested: [{ token: "" }],
	});
	delete process.env.MIR_TEST_TOKEN;
});

test("channel auth: token is required and compared exactly", () => {
	const options = { token: "s3cret-token" };
	assert.equal(verifyChannelRequest(options, {}, "").ok, false);
	assert.equal(verifyChannelRequest(options, { "x-mir-token": "wrong" }, "").ok, false);
	assert.equal(verifyChannelRequest(options, { "x-mir-token": "s3cret-token" }, "").ok, true);
	assert.equal(authConfigured(options), true);
	assert.equal(authConfigured({}), false);
});

test("channel auth: HMAC signature covers timestamp and body", () => {
	const secret = "hmac-secret";
	const body = JSON.stringify({ text: "hi" });
	const ts = "1700000000";
	const options = { hmacSecret: secret };
	const good = {
		"x-mir-signature": signChannelBody(secret, ts, body),
		"x-mir-timestamp": ts,
	};
	const now = Number(ts) * 1000;

	assert.equal(verifyChannelRequest(options, good, body, now).ok, true);
	assert.equal(
		verifyChannelRequest(options, good, body + " ", now).ok,
		false,
		"a tampered body must fail",
	);
	assert.equal(
		verifyChannelRequest(options, good, body, now + 10 * 60_000).ok,
		false,
		"a stale signature must fail the replay window",
	);
	assert.equal(verifyChannelRequest(options, {}, body, now).ok, false);
});

test("capabilities: JSON, grant-list and default forms", () => {
	// The environment is a hand's job: a Worker process gets no filesystem and no
	// egress unless someone says so.
	assert.deepEqual(parseCapabilities(undefined), {
		net: false,
		fs: "none",
		mcp: true,
		codemode: true,
	});
	assert.deepEqual(parseCapabilities('{"net":false,"fs":"ro"}'), {
		net: false,
		fs: "ro",
		mcp: true,
		codemode: true,
	});
	assert.deepEqual(parseCapabilities("net,fs:ro,mcp"), {
		net: true,
		fs: "ro",
		mcp: true,
		codemode: false,
	});
	// "all" is every grant a Worker may be given, not the defaults: a Worker that
	// needs a filesystem or the network asks for them by name.
	assert.deepEqual(parseCapabilities("all"), {
		net: true,
		fs: "rw",
		mcp: true,
		codemode: true,
	});
	assert.match(describeCapabilities(parseCapabilities("fs:none")), /filesystem=none/);
});

test("tool policy: glob matching, deny wins, allow is exclusive", () => {
	assert.equal(matchToolName("mcp__*", "mcp__github__issue"), true);
	assert.equal(matchToolName("codemode", "codemode"), true);
	assert.equal(matchToolName("read*", "write"), false);

	const names = ["read", "write", "bash", "codemode", "mcp__fs__read"];
	assert.deepEqual(filterToolNames(names, { deny: ["bash"] }), [
		"read",
		"write",
		"codemode",
		"mcp__fs__read",
	]);
	assert.deepEqual(filterToolNames(names, { allow: ["read", "codemode"] }), ["read", "codemode"]);
	assert.deepEqual(filterToolNames(names, { allow: ["*"], deny: ["mcp__*"] }), [
		"read",
		"write",
		"bash",
		"codemode",
	]);
});

test("filesystem capability: paths may not escape the worker root", () => {
	const root = "/srv/worker";
	assert.equal(resolveInsideRoot(root, "src/index.ts"), "/srv/worker/src/index.ts");
	assert.equal(resolveInsideRoot(root, "./a/../b.txt"), "/srv/worker/b.txt");
	assert.equal(resolveInsideRoot(root, "../etc/passwd"), null);
	assert.equal(resolveInsideRoot(root, "/etc/passwd"), null);
});
