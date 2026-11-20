/**
 * The work card, served as a `ui://` resource, so a client that speaks MCP Apps shows any
 * agent's card without knowing what a dispatch is.
 *
 * The entry is a pointer, not a snapshot: a reload asks the server for the state now. The
 * view polls through the host's bridge when it has one, and the durable path does not
 * depend on it. One self-contained document: no build step, no network beyond the bridge.
 */

export interface CardData {
	/** The task this card is about. The view asks the server for the rest. */
	taskId: string;
	title: string;
	description?: string;
	status?: string;
	/** Where the work runs, when it runs somewhere the person should see. */
	endpointId?: string;
	/** The answer, when there is one. */
	result?: string;
	error?: string;
	createdAt?: number;
}

/** The `ui://` URI the card is served at. */
export const CARD_URI = "ui://mir/work";

	/** The task is in the URI because the URI is what a client stores and re-reads. */
export function cardUriFor(taskId: string): string {
	return `${CARD_URI}?taskId=${encodeURIComponent(taskId)}`;
}

/** The task id in a card URI, when it names one. */
export function taskIdFromUri(uri: string): string | undefined {
	const query = uri.includes("?") ? uri.slice(uri.indexOf("?") + 1) : "";
	const value = new URLSearchParams(query).get("taskId");
	return value === null || value === "" ? undefined : value;
}

/** What a host must declare this view may reach: nothing. It talks to its server. */
export const CARD_MIME = "text/html;profile=mcp-app";

	/** Injected as JSON in a script tag, escaped so a title containing `</script>` stays text. */
export function renderCard(data: CardData): string {
	const json = JSON.stringify(data).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.title)}</title>
<style>
	:root {
		color-scheme: light dark;
		--ink: #14161a;
		--dim: #6b7280;
		--fill: rgba(20, 22, 26, 0.05);
		--fill-strong: rgba(20, 22, 26, 0.09);
		--ok: #1f7a4d;
		--bad: #b42318;
	}
	@media (prefers-color-scheme: dark) {
		:root {
			--ink: #e8eaed;
			--dim: #9aa1ac;
			--fill: rgba(255, 255, 255, 0.07);
			--fill-strong: rgba(255, 255, 255, 0.12);
			--ok: #4ade80;
			--bad: #f87171;
		}
	}
	html, body { margin: 0; background: transparent; }
	body {
		font: 13px/1.45 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
		color: var(--ink);
		padding: 2px;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px 12px;
		border-radius: 10px;
		background: var(--fill);
	}
	.head { display: flex; align-items: baseline; gap: 8px; }
	.title { font-weight: 600; flex: 1 1 auto; overflow-wrap: anywhere; }
	.state {
		flex: 0 0 auto;
		font-size: 11px;
		padding: 1px 7px;
		border-radius: 999px;
		background: var(--fill-strong);
		color: var(--dim);
		text-transform: lowercase;
	}
	.state.done { color: var(--ok); }
	.state.failed { color: var(--bad); }
	.description { color: var(--dim); overflow-wrap: anywhere; }
	.meta { color: var(--dim); font-size: 11.5px; display: flex; gap: 10px; flex-wrap: wrap; }
	.result {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		padding: 8px 10px;
		border-radius: 8px;
		background: var(--fill-strong);
	}
	.hidden { display: none; }
</style>
</head>
<body>
<div class="card" role="group" aria-label="Work">
	<div class="head">
		<span class="title" id="title"></span>
		<span class="state" id="state"></span>
	</div>
	<div class="description hidden" id="description"></div>
	<div class="meta hidden" id="meta"></div>
	<div class="result hidden" id="result"></div>
</div>
<script type="application/json" id="mir-data">${json}</script>
<script>
(function () {
	var initial = JSON.parse(document.getElementById("mir-data").textContent);
	var el = {
		title: document.getElementById("title"),
		state: document.getElementById("state"),
		description: document.getElementById("description"),
		meta: document.getElementById("meta"),
		result: document.getElementById("result")
	};

	function draw(data) {
		el.title.textContent = data.title || "Work";
		var state = data.status || "running";
		el.state.textContent = state;
		el.state.className = "state " + state;
		if (data.description) {
			el.description.textContent = data.description;
			el.description.classList.remove("hidden");
		}
		var meta = [];
		if (data.endpointId) meta.push("on " + data.endpointId);
		el.meta.textContent = meta.join(" · ");
		el.meta.classList.toggle("hidden", meta.length === 0);
		var answer = data.error || data.result;
		if (answer) {
			el.result.textContent = answer;
			el.result.classList.remove("hidden");
		}
	}

	draw(initial);

	// ---- the bridge, if this host has one ---------------------------------
	// The MCP Apps bridge is JSON-RPC over postMessage. A host that does not speak
	// it never answers, and nothing here waits on it: the entry is the durable
	// state, this is only how a running task's progress moves between entries.
	if (window.parent === window) return;

	var nextId = 1;
	var waiting = {};
	var alive = false;

	window.addEventListener("message", function (event) {
		var message = event.data;
		if (!message || message.jsonrpc !== "2.0") return;
		if (message.id && waiting[message.id]) {
			waiting[message.id](message);
			delete waiting[message.id];
			return;
		}
		// The host's own handshake: answer a ping, remember that the bridge is there.
		if (message.method === "ui/initialize") alive = true;
	});

	function request(method, params) {
		var id = nextId++;
		return new Promise(function (resolve) {
			waiting[id] = resolve;
			window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
			setTimeout(function () { delete waiting[id]; }, 4000);
		});
	}

	function callTool(name, args) {
		return request("tools/call", { name: name, arguments: args }).then(function (message) {
			var result = message && message.result;
			if (!result) return null;
			if (result.structuredContent) return result.structuredContent;
			if (result.content && result.content[0] && result.content[0].text) {
				try { return JSON.parse(result.content[0].text); } catch (e) { return null; }
			}
			return null;
		});
	}

	var timer = null;
	function startPolling() {
		if (timer !== null) return;
		var tick = function () {
			callTool("work_status", { taskId: initial.taskId }).then(function (data) {
				if (data && data.taskId) draw(data);
			});
		};
		tick();
		timer = window.setInterval(tick, 1500);
	}

	// Announce, then poll. ui/initialize is the spec's first message; a host that
	// answers is one we can ask for state.
	request("ui/initialize", { appInfo: { name: "mir-work", version: "1" }, appCapabilities: {} }).then(function (message) {
		if (message && (message.result || message.error)) alive = true;
		if (alive) startPolling();
	});

	window.addEventListener("pagehide", function () {
		if (timer !== null) window.clearInterval(timer);
		timer = null;
	});
})();
</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}
