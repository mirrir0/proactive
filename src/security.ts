/**
 * The three controls that make the daemon deployable: redaction of every known secret,
 * channel authentication, and capability gating for a Worker's tools. Nothing here
 * imports agent code, so every layer can use it.
 */

import crypto from "node:crypto";


/** Shorter values would mangle ordinary text. */
const MIN_SECRET_LENGTH = 8;

/** Suffixes that make an env var a secret. */
const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH)/i;

export class SecretRegistry {
/** value → name, for the marker. */
	private readonly byValue = new Map<string, string>();

/** Idempotent. */
	add(name: string, value: string | undefined | null): void {
		if (!value || value.length < MIN_SECRET_LENGTH) return;
		if (this.byValue.has(value)) return;
		this.byValue.set(value, name);
	}

/** Defaults to `process.env`. */
	addFromEnv(env: NodeJS.ProcessEnv = process.env): void {
		for (const [name, value] of Object.entries(env)) {
			if (!SECRET_NAME_RE.test(name)) continue;
			this.add(name, value);
		}
	}

	get size(): number {
		return this.byValue.size;
	}

	/** True when `value` is a registered secret. */
	contains(value: string): boolean {
		return this.byValue.has(value);
	}

	/**
	 * Longest-first, so a secret that contains another secret wins.
	 */
	redact(text: string): string {
		if (!text || this.byValue.size === 0) return text;
		let out = text;
		const entries = [...this.byValue.entries()].sort((a, b) => b[0].length - a[0].length);
		for (const [value, name] of entries) {
			if (!out.includes(value)) continue;
			out = out.split(value).join(`«redacted:${name}»`);
		}
		return out;
	}
}

/** Populated at startup. */
export const secrets = new SecretRegistry();

/** Over the process-wide registry. */
export function redactSecrets(text: string): string {
	return secrets.redact(text);
}

	/**
	 * A config on disk can carry `${env:NAME}` instead of a value, resolved here at use
	 * time so the file holds no key.
	 */
export function resolveSecretRefs<T>(value: T): T {
	const walk = (node: unknown): unknown => {
		if (typeof node === "string") {
			// Inline form so "Bearer ${env:TOKEN}" works, not just a bare placeholder.
			return node.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, name: string) => process.env[name] ?? "");
		}
		if (Array.isArray(node)) return node.map(walk);
		if (node && typeof node === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
			return out;
		}
		return node;
	};
	return walk(value) as T;
}


export interface ChannelAuthOptions {
/** Empty disables token auth. */
	token?: string;
	tokenHeader?: string;
/** Empty disables signature auth. */
	hmacSecret?: string;
	signatureHeader?: string;
	timestampHeader?: string;
/** Replay window. Default 5 minutes. */
	maxSkewMs?: number;
}

export interface AuthResult {
	ok: boolean;
	reason?: string;
}

function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return crypto.timingSafeEqual(ab, bb);
}

/** Exported for tests and clients. */
export function signChannelBody(secret: string, timestamp: string, rawBody: string): string {
	const digest = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
	return `sha256=${digest}`;
}

	/** Both checks are optional and independent; a configured one that fails is a refusal. */
export function verifyChannelRequest(
	options: ChannelAuthOptions,
	headers: Record<string, string | string[] | undefined>,
	rawBody: string,
	now: number = Date.now(),
): AuthResult {
	const header = (name: string): string | undefined => {
		const v = headers[name.toLowerCase()];
		return Array.isArray(v) ? v[0] : v;
	};

	if (options.token) {
		const supplied = header(options.tokenHeader ?? "x-mir-token") ?? "";
		if (!supplied) return { ok: false, reason: "missing channel token" };
		if (!safeEqual(supplied, options.token)) return { ok: false, reason: "invalid channel token" };
	}

	if (options.hmacSecret) {
		const supplied = header(options.signatureHeader ?? "x-mir-signature") ?? "";
		const ts = header(options.timestampHeader ?? "x-mir-timestamp") ?? "";
		if (!supplied) return { ok: false, reason: "missing signature" };
		if (!ts) return { ok: false, reason: "missing signature timestamp" };
		const skewMs = options.maxSkewMs ?? 5 * 60_000;
		const tsMs = Number(ts) * (String(ts).length <= 10 ? 1000 : 1);
		if (!Number.isFinite(tsMs)) return { ok: false, reason: "invalid signature timestamp" };
		if (Math.abs(now - tsMs) > skewMs) return { ok: false, reason: "signature timestamp outside replay window" };
		const expected = signChannelBody(options.hmacSecret, ts, rawBody);
		if (!safeEqual(supplied, expected)) return { ok: false, reason: "invalid signature" };
	}

	return { ok: true };
}

/** True when any authentication is configured. */
export function authConfigured(options: ChannelAuthOptions): boolean {
	return Boolean(options.token || options.hmacSecret);
}


export type FsCapability = "none" | "ro" | "rw";

export interface WorkerCapabilities {
	/** `fetch` in codemode. */
	net: boolean;
	/** `readFile`/`writeFile` in codemode. */
	fs: FsCapability;
	/** Whether MCP servers are connected at all. */
	mcp: boolean;
	/** Whether the `codemode` tool exists. */
	codemode: boolean;
}

/**
 * What a Worker may do in its own process, when nothing says otherwise.
 *
 * `fs: "none"` and `net: false` because the Worker's environment is a hand: a hand
 * has roots, a policy and a sandbox, and the Worker process has none of those. The
 * two that stay on are the ones that are not disk or egress — connected services and
 * codemode's pure computation.
 */
export const DEFAULT_WORKER_CAPABILITIES: WorkerCapabilities = {
	net: false,
	fs: "none",
	mcp: true,
	codemode: true,
};

/** Parse capabilities from JSON, a comma list of grants, or nothing. */
export function parseCapabilities(raw: string | undefined | null): WorkerCapabilities {
	if (!raw || !raw.trim()) return { ...DEFAULT_WORKER_CAPABILITIES };
	const trimmed = raw.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as Partial<WorkerCapabilities>;
			return { ...DEFAULT_WORKER_CAPABILITIES, ...parsed };
		} catch {
			return { ...DEFAULT_WORKER_CAPABILITIES };
		}
	}
	// Grant-list form: "net,fs:ro,mcp" (anything not granted is denied).
	const caps: WorkerCapabilities = { net: false, fs: "none", mcp: false, codemode: false };
	for (const grant of trimmed.split(",").map((s) => s.trim()).filter(Boolean)) {
		if (grant === "net") caps.net = true;
		else if (grant === "mcp") caps.mcp = true;
		else if (grant === "codemode") caps.codemode = true;
		else if (grant === "fs") caps.fs = "rw";
		else if (grant === "fs:ro") caps.fs = "ro";
		else if (grant === "fs:rw") caps.fs = "rw";
		// "all" means every grant, not the defaults: an operator who writes it is
		// asking for the filesystem and the network by name.
		else if (grant === "all") return { net: true, fs: "rw", mcp: true, codemode: true };
	}
	return caps;
}

/** Human-readable capability line, injected into the worker prompt. */
export function describeCapabilities(caps: WorkerCapabilities): string {
	const parts = [
		`network=${caps.net ? "allowed" : "denied"}`,
		`filesystem=${caps.fs}`,
		`mcp=${caps.mcp ? "enabled" : "disabled"}`,
		`codemode=${caps.codemode ? "enabled" : "disabled"}`,
	];
	return parts.join(", ");
}

/** Glob-ish tool matcher: `*` matches any run of characters. */
export function matchToolName(pattern: string, name: string): boolean {
	if (pattern === name) return true;
	if (!pattern.includes("*")) return false;
	const re = new RegExp(
		"^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
	);
	return re.test(name);
}

/**
 * Apply an allow/deny policy to a tool set.
 * Deny wins; a non-empty allow list means "only these".
 */
export function filterToolNames(
	names: string[],
	policy: { allow?: string[]; deny?: string[] },
): string[] {
	return names.filter((name) => {
		if (policy.deny?.some((p) => matchToolName(p, name))) return false;
		if (policy.allow && policy.allow.length > 0) {
			return policy.allow.some((p) => matchToolName(p, name));
		}
		return true;
	});
}
