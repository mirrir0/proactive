#!/usr/bin/env node
/**
 * `mir endpoint` — the program that runs where work happens. It holds no session state,
 * dials out, enforces the machine owner's policy, and uses the machine's own credentials.
 * Every flag has a `MIR_HANDS_*` fallback, so it installs as a service.
 */

import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import os from "node:os";
import { homedir } from "node:os";
import { loadEnv } from "../env.ts";
import { HandExecutor } from "../hands/executor.ts";
import { createSandbox, type SandboxWrapper } from "../hands/sandbox.ts";
import {
	FrameDecoder,
	HANDS_PROTOCOL_VERSION,
	encodeFrame,
	type EndpointToHub,
	type HandCapabilities,
	type HandOp,
	type HandPolicy,
	type HubToEndpoint,
} from "../hands/protocol.ts";
import { DEFAULT_HAND_POLICY } from "../hands/protocol.ts";
import { normalizePolicy, policySummary } from "../hands/policy.ts";
import { SecretRegistry } from "../security.ts";
import { createLogger, type Logger } from "../telemetry.ts";

export interface EndpointHubTarget {
	host: string;
	port: number;
	tls: boolean;
	ca?: string;
	insecure?: boolean;
}

export interface EndpointOptions {
	hub: EndpointHubTarget;
	id: string;
	token: string;
	name: string;
	policy: HandPolicy;
	capabilities: HandCapabilities;
	heartbeatMs: number;
	log: Logger;
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class EndpointDaemon {
	private socket: net.Socket | tls.TLSSocket | null = null;
	private heartbeat: NodeJS.Timeout | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private reconnectDelay = RECONNECT_MIN_MS;
	private stopping = false;
	private welcomed = false;
	private running = 0;
	private readonly aborts = new Map<string, AbortController>();
	private executor: HandExecutor | null = null;
	private sandbox: SandboxWrapper | null = null;
	private readonly secrets = new SecretRegistry();

	constructor(private readonly options: EndpointOptions) {
		this.secrets.addFromEnv();
		this.secrets.add("MIR_HANDS_TOKEN", options.token);
	}

	/** A hand that cannot enforce its policy refuses to start rather than run unconfined. */
	async start(): Promise<void> {
		if (this.options.policy.sandbox !== "none") {
			this.sandbox = await createSandbox(
				this.options.policy,
				this.options.capabilities,
				this.options.log,
			);
		} else {
			this.options.log.warn("sandbox disabled; path and network policy are not enforced", {
				endpoint: this.options.id,
			});
		}
		this.executor = new HandExecutor({
			policy: this.options.policy,
			capabilities: this.options.capabilities,
			secrets: this.secrets,
			log: this.options.log,
			sandbox: this.sandbox ?? undefined,
		});
		this.stopping = false;
		this.connect();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.reconnectTimer = null;
		this.heartbeat = null;
		for (const controller of this.aborts.values()) controller.abort();
		this.aborts.clear();
		if (this.socket && !this.socket.destroyed) {
			try {
				this.socket.write(encodeFrame({ type: "bye", reason: "endpoint shutting down" }));
			} catch {
				/* already gone */
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 500);
				timer.unref();
				this.socket?.once("close", () => {
					clearTimeout(timer);
					resolve();
				});
				this.socket?.end();
			});
		}
		this.socket?.destroy();
		this.socket = null;
		await this.sandbox?.dispose().catch(() => {});
		this.sandbox = null;
	}

	private connect(): void {
		if (this.stopping) return;
		const { hub } = this.options;
		const target = `${hub.host}:${hub.port}${hub.tls ? " (tls)" : ""}`;
		this.options.log.info("connecting to hub", { hub: target, endpoint: this.options.id });

		const socket = hub.tls
			? tls.connect({
					host: hub.host,
					port: hub.port,
					ca: hub.ca,
					servername: hub.host,
					rejectUnauthorized: !hub.insecure,
				})
			: net.createConnection({ host: hub.host, port: hub.port });
		this.socket = socket;
		socket.setNoDelay(true);

		const decoder = new FrameDecoder<HubToEndpoint>((message) => this.handle(message));
		socket.on("data", (chunk) => {
			if (!decoder.push(chunk).ok) socket.destroy();
		});
		socket.on(hub.tls ? "secureConnect" : "connect", () => {
			this.send({
				type: "hello",
				v: HANDS_PROTOCOL_VERSION,
				endpointId: this.options.id,
				token: this.options.token,
				name: this.options.name,
				capabilities: this.options.capabilities,
				// What this machine enforces, for the operator to read. The hub never
				// decides anything with it: the hand is the security principal.
				policySummary: policySummary(this.options.policy, this.options.capabilities),
				meta: { platform: process.platform, arch: process.arch, host: safeHostname() },
			});
		});
		socket.on("close", () => this.onDisconnect("connection closed"));
		socket.on("error", (err) => this.onDisconnect(err.message));
	}

	private onDisconnect(reason: string): void {
		this.welcomed = false;
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = null;
		this.socket = null;
		for (const controller of this.aborts.values()) controller.abort();
		this.aborts.clear();
		if (this.stopping) return;
		const delay = this.reconnectDelay;
		this.reconnectDelay = Math.min(RECONNECT_MAX_MS, this.reconnectDelay * 2);
		this.options.log.warn("hub connection lost; reconnecting", { reason, inMs: delay });
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = setTimeout(() => this.connect(), delay);
		this.reconnectTimer.unref?.();
	}

	private send(message: EndpointToHub): void {
		if (!this.socket || this.socket.destroyed) return;
		this.socket.write(encodeFrame(message));
	}

	private handle(message: HubToEndpoint): void {
		switch (message.type) {
			case "welcome":
				this.welcomed = true;
				this.reconnectDelay = RECONNECT_MIN_MS;
				this.options.log.info("hand registered with hub", {
					endpoint: message.endpointId,
					heartbeatMs: message.heartbeatMs,
				});
				this.startHeartbeat(Math.min(message.heartbeatMs || this.options.heartbeatMs, this.options.heartbeatMs));
				break;
			case "work":
				void this.runWork(message.work.workId, message.work.op, message.work.input, message.work.maxOutputBytes);
				break;
			case "cancel": {
				this.aborts.get(message.workId)?.abort();
				break;
			}
			case "ping":
				this.send({ type: "pong", id: message.id });
				break;
			case "reject":
				this.options.log.error("hub rejected this hand", {
					code: message.code,
					message: message.message,
				});
				// A rejected hand must not hammer the hub: back off hard and stay put.
				this.stopping = false;
				this.onDisconnect(`rejected: ${message.code}`);
				break;
		}
	}

	private startHeartbeat(intervalMs: number): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = setInterval(() => {
			this.send({ type: "heartbeat", at: Date.now(), load: { running: this.running } });
		}, Math.max(1000, intervalMs));
		this.heartbeat.unref?.();
	}

	private async runWork(
		workId: string,
		op: HandOp,
		input: unknown,
		maxOutputBytes: number,
	): Promise<void> {
		const executor = this.executor;
		if (!executor) {
			this.send({
				type: "result",
				workId,
				result: { ok: false, error: "hand is not ready", durationMs: 0 },
			});
			return;
		}
		const controller = new AbortController();
		this.aborts.set(workId, controller);
		this.running++;
		this.send({ type: "accepted", workId });
		try {
			const result = await executor.run(op, input, {
				signal: controller.signal,
				maxOutputBytes,
				onChunk: (stream, data) => this.send({ type: "chunk", workId, stream, data }),
			});
			this.send({ type: "result", workId, result });
		} catch (err) {
			this.send({
				type: "result",
				workId,
				result: { ok: false, error: (err as Error).message, durationMs: 0 },
			});
		} finally {
			this.running--;
			this.aborts.delete(workId);
		}
	}
}

function safeHostname(): string {
	try {
		return os.hostname();
	} catch {
		return "unknown";
	}
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
	return value;
}

function splitList(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const parts = value
		.split(/[,\n]/)
		.map((part) => part.trim())
		.filter(Boolean);
	return parts.length ? parts : undefined;
}

function num(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function flag(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(`--${name}`);
	if (index < 0) return undefined;
	return argv[index + 1];
}

function multiFlag(argv: string[], name: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === `--${name}` && argv[i + 1]) values.push(argv[i + 1]!);
	}
	return values;
}

	/** `srt` fences writes and network; `confined` is what a space asks for, because it fences reads too. */
function sandboxKind(requested: string | undefined, noSandbox: boolean): "none" | "srt" | "confined" {
	if (noSandbox) return "none";
	const wanted = (requested ?? "").trim().toLowerCase();
	if (wanted === "0" || wanted === "none" || wanted === "off" || wanted === "false") return "none";
	if (wanted === "confined" || wanted === "strict") return "confined";
	return "srt";
}

function hasFlag(argv: string[], name: string): boolean {
	return argv.includes(`--${name}`);
}

export function usage(): string {
	return [
		"mir endpoint — run work for a mir hub on this machine",
		"",
		"  mir endpoint --hub <host:port> --id <id> --token <token> [options]",
		"",
		"  --hub <host:port>       hub address (env MIR_HANDS_HUB)            required",
		"  --id <id>               hand id registered with the hub           required",
		"  --token <token>         hand token from `mir hands add`           required",
		"  --name <name>           display name (default: hostname)",
		"  --root <path>           filesystem root; repeatable (default: cwd)",
		"  --allow <a,b,c>         executable allowlist (default: common dev tools)",
		"  --deny <a,b,c>          executable denylist (wins over --allow)",
		"  --fs <none|ro|rw>       filesystem capability (default rw)",
		"  --shell                 allow `sh -c` (requires `sh` in --allow)",
		"  --no-exec               deny command execution entirely",
		"  --no-git                deny git",
		"  --max-concurrent <n>    concurrent work items (default 2)",
		"  --timeout <ms>          default per-command timeout",
		"  --max-timeout <ms>      hard cap on a caller-supplied timeout",
		"  --max-output <bytes>    output cap per command",
		"  --env-allow <A,B>       extra env var names passed to children",
		"  --sandbox <kind>        none | srt (write fence, reads open) | confined (reads and writes in the roots)",
		"  --no-sandbox            disable the OS sandbox (allowlist only; not recommended)",
		"  --allow-net <a,b>       domains the hand may reach (default: none)",
		"  --deny-net <a,b>        domains to deny even if allowed",
		"  --allow-local-binding   allow binding local ports (dev servers)",
		"  --allow-unix-socket <p> unix socket the sandbox may connect to; repeatable",
		"  --deny-read <p>         path the sandbox may not read; repeatable",
		"  --deny-write <p>        path the sandbox may not write; repeatable",
		"  --tls                   connect to the hub over TLS",
		"  --ca <path>             CA bundle for the hub certificate",
		"  --insecure              skip TLS verification (testing only)",
		"  --heartbeat <ms>        heartbeat interval",
		"",
		"Everything also reads MIR_HANDS_* environment variables, so it can run",
		"under launchd/systemd with the token supplied by the environment.",
	].join("\n");
}

export function parseEndpointArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): EndpointOptions {
	const hubSpec = flag(argv, "hub") ?? env.MIR_HANDS_HUB;
	if (!hubSpec) throw new Error("missing --hub (or MIR_HANDS_HUB)");
	const id = flag(argv, "id") ?? env.MIR_HANDS_ID;
	if (!id) throw new Error("missing --id (or MIR_HANDS_ID)");
	const token = flag(argv, "token") ?? env.MIR_HANDS_TOKEN;
	if (!token) throw new Error("missing --token (or MIR_HANDS_TOKEN)");

	const [host, portRaw] = hubSpec.includes("://")
		? (() => {
				const url = new URL(hubSpec);
				return [url.hostname, url.port];
			})()
		: hubSpec.split(":");
	const port = Number(portRaw ?? 4700);
	if (!host || !Number.isFinite(port)) throw new Error(`invalid --hub "${hubSpec}" (expected host:port)`);

	const useTls =
		hasFlag(argv, "tls") || hubSpec.startsWith("tls://") || env.MIR_HANDS_TLS === "1" || env.MIR_HANDS_TLS === "true";

	const roots = multiFlag(argv, "root");
	const envRoots = splitList(env.MIR_HANDS_ROOTS);
	const resolvedRoots = (roots.length ? roots : (envRoots ?? [process.cwd()])).map((root) =>
		path.resolve(expandHome(root)),
	);

	const allow = splitList(flag(argv, "allow") ?? env.MIR_HANDS_ALLOW) ?? DEFAULT_HAND_POLICY.allow;
	const deny = splitList(flag(argv, "deny") ?? env.MIR_HANDS_DENY) ?? [];

	const fsMode = (flag(argv, "fs") ?? env.MIR_HANDS_FS ?? "rw") as HandCapabilities["fs"];
	if (!["none", "ro", "rw"].includes(fsMode)) throw new Error(`invalid --fs "${fsMode}"`);

	const capabilities: HandCapabilities = {
		exec: !hasFlag(argv, "no-exec") && env.MIR_HANDS_EXEC !== "0",
		shell: hasFlag(argv, "shell") || env.MIR_HANDS_SHELL === "1" || env.MIR_HANDS_SHELL === "true",
		fs: fsMode,
		git: !hasFlag(argv, "no-git") && env.MIR_HANDS_GIT !== "0",
	};

	const policy = normalizePolicy({
		roots: resolvedRoots,
		allow,
		deny,
		// 0 is "no limit": the machine is the limit, and a brain-invented cap turned three
		// independent reads into "hand is at capacity".
		maxConcurrent: num(flag(argv, "max-concurrent") ?? env.MIR_HANDS_MAX_CONCURRENT, DEFAULT_HAND_POLICY.maxConcurrent ?? 0),
		defaultTimeoutMs: num(flag(argv, "timeout") ?? env.MIR_HANDS_TIMEOUT_MS, DEFAULT_HAND_POLICY.defaultTimeoutMs),
		maxTimeoutMs: num(flag(argv, "max-timeout") ?? env.MIR_HANDS_MAX_TIMEOUT_MS, DEFAULT_HAND_POLICY.maxTimeoutMs),
		maxOutputBytes: num(flag(argv, "max-output") ?? env.MIR_HANDS_MAX_OUTPUT, DEFAULT_HAND_POLICY.maxOutputBytes),
		envAllow: splitList(flag(argv, "env-allow") ?? env.MIR_HANDS_ENV_ALLOW) ?? [],
		sandbox: sandboxKind(flag(argv, "sandbox") ?? env.MIR_HANDS_SANDBOX, hasFlag(argv, "no-sandbox")),
		network: {
			allowedDomains: splitList(flag(argv, "allow-net") ?? env.MIR_HANDS_ALLOW_NET) ?? [],
			deniedDomains: splitList(flag(argv, "deny-net") ?? env.MIR_HANDS_DENY_NET) ?? [],
			allowLocalBinding:
				hasFlag(argv, "allow-local-binding") || env.MIR_HANDS_ALLOW_LOCAL_BINDING === "1",
			allowUnixSockets: multiFlag(argv, "allow-unix-socket"),
		},
		denyReadPaths: multiFlag(argv, "deny-read"),
		denyWritePaths: multiFlag(argv, "deny-write"),
	});

	return {
		hub: {
			host,
			port,
			tls: useTls,
			ca: flag(argv, "ca") ?? env.MIR_HANDS_CA,
			insecure: hasFlag(argv, "insecure") || env.MIR_HANDS_INSECURE === "1",
		},
		id,
		token,
		name: flag(argv, "name") ?? env.MIR_HANDS_NAME ?? safeHostname(),
		policy,
		capabilities,
		heartbeatMs: num(flag(argv, "heartbeat") ?? env.MIR_HANDS_HEARTBEAT_MS, 15_000),
		log: createLogger({ base: { component: "endpoint", endpoint: id } }),
	};
}

export async function runEndpoint(argv = process.argv.slice(2)): Promise<void> {
	if (hasFlag(argv, "help") || argv.includes("-h")) {
		console.log(usage());
		return;
	}
	loadEnv();
	let options: EndpointOptions;
	try {
		options = parseEndpointArgs(argv);
	} catch (err) {
		console.error(`mir endpoint: ${(err as Error).message}\n`);
		console.error(usage());
		process.exit(1);
	}

	const { log } = options;
	log.info("hand starting", {
		endpoint: options.id,
		name: options.name,
		hub: `${options.hub.host}:${options.hub.port}`,
		tls: options.hub.tls,
		capabilities: options.capabilities,
		roots: options.policy.roots,
		allow: options.policy.allow,
		maxConcurrent: options.policy.maxConcurrent,
	});
	if (!options.hub.tls && !isLoopback(options.hub.host)) {
		log.warn("connecting to a remote hub without TLS; the hand token would cross the network in clear text", {
			hint: "use --tls (or MIR_HANDS_TLS=1) and --ca",
		});
	}
	if (options.policy.sandbox === "none" && options.capabilities.exec) {
		log.warn("exec is granted without an OS sandbox; the allowlist limits which programs run, not what they touch or reach", {
			hint: "drop --no-sandbox to enforce path and network policy through the sandbox runtime",
		});
	}
	if (options.capabilities.shell) {
		log.warn("shell execution is granted; the executable allowlist cannot constrain a shell string", {
			allow: options.policy.allow,
		});
	}

	const daemon = new EndpointDaemon(options);
	try {
		await daemon.start();
	} catch (err) {
		log.error("hand failed to start", { error: (err as Error).message });
		process.exit(1);
	}

	const shutdown = async (signal: string) => {
		log.info("shutting down", { signal });
		await daemon.stop();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: String(reason) }));
	process.on("uncaughtException", (err) => log.error("uncaught exception", { error: err.message }));
}

function isLoopback(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

const invokedDirectly =
	process.argv[1] && /(endpoint[\\/]main|mir-endpoint)\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
	runEndpoint().catch((err) => {
		console.error("mir-endpoint fatal:", err?.message ?? err);
		process.exit(1);
	});
}

