/**
 * OAuth login support for MCP HTTP servers.
 *
 * When an MCP server requires OAuth (401 on first request), we run the full
 * authorization code flow:
 *   1. Discover the authorization server metadata from the MCP server URL
 *   2. Register an OAuth client (or reuse stored credentials)
 *   3. Print an authorization URL for the user to visit in a browser
 *   4. Start a local callback server to receive the authorization code
 *   5. Exchange the code for access/refresh tokens
 *   6. Store tokens durably so future runs don't need re-login
 *
 * Tokens are stored per-server-URL in `~/.local/share/mir/mcp-oauth/<host>.json`.
 *
 * Built on @earendil-works/pi-mcp's OAuth flow:
 *   - McpOAuthProvider implements OAuthClientProvider
 *   - adaptOAuthProvider(provider) -> AuthProvider for StreamableHttpTransport
 *   - OAuthCallbackServer.listen() -> local HTTP callback endpoint
 *   - authorizeMcp(provider, options) -> discovery/register/authorize
 */

import {
	McpOAuthProvider,
	type McpOAuthState,
	McpOAuthAuthorizationRequiredError,
	OAuthCallbackServer,
	authorizeMcp,
	adaptOAuthProvider,
} from "@earendil-works/pi-mcp/oauth";
import {
	AuthProvider,
	type UnauthorizedContext,
} from "@earendil-works/pi-mcp";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/** File-based OAuth state store — one instance per server URL. */
class FileOAuthStateStore {
	private file: string;
	private state: McpOAuthState | undefined;

	constructor(serverUrl: string) {
		const dir = join(homedir(), ".local", "share", "mir", "mcp-oauth");
		mkdirSync(dir, { recursive: true });
		const host = new URL(serverUrl).host.replace(/[^a-z0-9.-]/gi, "_");
		this.file = join(dir, `oauth-${host}.json`);
		this.state = this.loadFromDisk();
	}

	private loadFromDisk(): McpOAuthState | undefined {
		try {
			if (!existsSync(this.file)) return undefined;
			return JSON.parse(readFileSync(this.file, "utf8")) as McpOAuthState;
		} catch {
			return undefined;
		}
	}

	load(): McpOAuthState | undefined {
		return this.state;
	}

	save(state: McpOAuthState): void {
		this.state = state;
		writeFileSync(this.file, JSON.stringify(state, null, 2));
	}
}

/**
 * Manager for MCP OAuth flows. One instance per Worker process.
 *
 * Creates McpOAuthProvider + AuthProvider per server URL, and runs the
 * interactive authorization flow when a server requires login.
 */
export class OAuthManager {
	private providers = new Map<string, McpOAuthProvider>();
	private adapters = new Map<string, AuthProvider>();

	/** Get (or create) an AuthProvider for the given MCP server URL. */
	getAuthProvider(serverUrl: string): AuthProvider {
		let adapter = this.adapters.get(serverUrl);
		if (adapter) return adapter;

		const provider = this.createProvider(serverUrl);
		this.providers.set(serverUrl, provider);
		adapter = adaptOAuthProvider(provider);
		this.adapters.set(serverUrl, adapter);
		return adapter;
	}

	private createProvider(serverUrl: string): McpOAuthProvider {
		return new McpOAuthProvider({
			serverUrl,
			redirectUrl: "http://127.0.0.1:34789/callback",
			clientMetadata: {
				redirect_uris: ["http://127.0.0.1:34789/callback"],
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				client_name: "mir-worker",
			},
			store: new FileOAuthStateStore(serverUrl),
			onRedirect: (_url: URL) => {
				// Captured per-flow in authorize().
			},
		});
	}

	/**
	 * Run the interactive OAuth authorization flow for a server.
	 * Prints an authorization URL, starts a callback server,
	 * waits for the user to complete the flow, and stores tokens.
	 *
	 * Returns true when authorized, false when the user declined or failed.
	 */
	async authorize(serverUrl: string): Promise<boolean> {
		let provider = this.providers.get(serverUrl);
		if (!provider) {
			provider = this.createProvider(serverUrl);
			this.providers.set(serverUrl, provider);
			this.adapters.set(serverUrl, adaptOAuthProvider(provider));
		}

		// Check if we already have tokens — if so, no need to authorize.
		const existing = await provider.tokens();
		if (existing) {
			console.error(`[mcp-oauth] already authorized for ${serverUrl}`);
			return true;
		}

		// Capture the authorization URL when the provider redirects the user.
		let authUrl: URL | undefined;
		const redirectProvider = new McpOAuthProvider({
			serverUrl,
			redirectUrl: "http://127.0.0.1:34789/callback",
			clientMetadata: {
				redirect_uris: ["http://127.0.0.1:34789/callback"],
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				client_name: "mir-worker",
			},
			store: new FileOAuthStateStore(serverUrl),
			onRedirect: (url: URL) => {
				authUrl = url;
			},
		});

		// Start a callback server to receive the authorization redirect.
		let callback: OAuthCallbackServer | undefined;
		try {
			callback = await OAuthCallbackServer.listen({
				host: "127.0.0.1",
				port: 34789,
				path: "/callback",
				timeoutMs: 300_000,
			});
		} catch (err) {
			console.error(`[mcp-oauth] failed to start callback server:`, (err as Error).message);
			return false;
		}

		try {
			const result = await authorizeMcp(redirectProvider, {
				serverUrl,
				skipRefresh: true,
			});

			if (result === "AUTHORIZED") {
				console.error(`[mcp-oauth] authorized for ${serverUrl}`);
				return true;
			}

			// result === "REDIRECT" — print the auth URL for the user.
			console.error(`[mcp-oauth] =========================================`);
			console.error(`[mcp-oauth] MCP OAuth authorization required for: ${serverUrl}`);
			if (authUrl) {
				console.error(`[mcp-oauth] Open this URL in a browser:`);
				console.error(`[mcp-oauth]   ${authUrl}`);
			}
			console.error(`[mcp-oauth] Waiting for callback (5 minutes)...`);
			console.error(`[mcp-oauth] =========================================`);

			try {
				const state = await redirectProvider.state();
				const cb = await callback.waitForCallback(state);
				console.error(
					`[mcp-oauth] callback received (code=${cb.code.slice(0, 8)}...).`
				);
				const tokens = await redirectProvider.tokens();
				if (tokens) {
					console.error(`[mcp-oauth] tokens stored for ${serverUrl}`);
					// Persist tokens to the main provider too.
					await provider.saveTokens(tokens);
					return true;
				}
				console.error(`[mcp-oauth] no tokens after callback`);
				return false;
			} catch (err) {
				console.error(`[mcp-oauth] callback wait failed:`, (err as Error).message);
				return false;
			}
		} catch (err) {
			console.error(`[mcp-oauth] authorization failed:`, (err as Error).message);
			return false;
		} finally {
			await callback?.close().catch(() => {});
		}
	}

	/**
	 * Ensure the server is authorized. If tokens exist, return the auth provider.
	 * If not, run the interactive OAuth flow first.
	 */
	async ensureAuthorized(serverUrl: string): Promise<AuthProvider> {
		const adapter = this.getAuthProvider(serverUrl);
		const provider = this.providers.get(serverUrl)!;
		const tokens = await provider.tokens();
		if (!tokens) {
			const ok = await this.authorize(serverUrl);
			if (!ok) {
				throw new Error(
					`OAuth authorization required for ${serverUrl} but not granted`
				);
			}
		}
		return this.adapters.get(serverUrl)!;
	}
}

/** Singleton OAuthManager per process. */
let oauthManager: OAuthManager | null = null;

export function getOAuthManager(): OAuthManager {
	if (!oauthManager) {
		oauthManager = new OAuthManager();
	}
	return oauthManager;
}

/**
 * A no-op AuthProvider for servers that don't need OAuth.
 * Returns undefined token (no Authorization header).
 */
export const noAuthProvider: AuthProvider = {
	async token(): Promise<string | undefined> {
		return undefined;
	},
	async onUnauthorized(_ctx: UnauthorizedContext): Promise<void> {
		// No-op: server doesn't use OAuth.
	},
};
