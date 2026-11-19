/**
 * html.ts — the dashboard, as one document.
 *
 * Same reason the card is one document: a dashboard that needs a bundler is a
 * dashboard the agent has to ship a toolchain for, and this one is served by the
 * brain itself on the machine it runs on.
 *
 * The look is the product's, not a new one. The tokens below are anomalous's
 * Between palette and its soft-corner scale — the ground, the card, the document,
 * three inks, one orange, the status fills, the type steps, the radii — copied as
 * *values* so this page reads as the same system without importing a stylesheet
 * the brain cannot depend on. Everything is a filled box on a quiet ground: no
 * borders, no shadows, no cards inside cards; separation is space and a shade.
 *
 * Live, not polled: one `EventSource` on `/api/events`, and the page re-renders
 * from the payload it pushes. A reload asks `/api/state` and gets the truth, so a
 * dashboard left open overnight and a dashboard opened just now agree.
 */

export interface DashboardOptions {
	/** The brain's name, for the header. */
	agent: string;
	/** Where the API lives, relative to the page. */
	basePath?: string;
}

export function renderDashboard(options: DashboardOptions): string {
	const base = options.basePath ?? "";
	return `<!doctype html>
<html lang="en" data-radius="soft" data-surface="cool" data-accent="orange">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.agent)} — mir</title>
<style>
	:root {
		color-scheme: light dark;
		--face-ui: "Fira Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
		--face-mono: "Geist Mono", "SF Mono", ui-monospace, monospace;

		--size-micro: 10px;
		--size-label: 11.5px;
		--size-small: 12.5px;
		--size-ui: 13px;
		--size-subheading: 14.5px;
		--size-heading: 19px;
		--size-title: 26px;

		--row: 30px;
		--pad: 16px;
		--gap: 10px;

		--box-radius: 7px;
		--chip-radius: 7px;
		--tile-radius: 5px;
		--radius: 10px;

		--surface-hue: 260;
		--ground: oklch(0.972 0.0015 var(--surface-hue));
		--card: oklch(0.978 0.0015 var(--surface-hue));
		--document: oklch(0.994 0.001 var(--surface-hue));
		--hover: oklch(0.945 0.002 var(--surface-hue));
		--active: oklch(0.925 0.0025 var(--surface-hue));

		--ink: oklch(0.18 0.003 var(--surface-hue));
		--ink-secondary: oklch(0.45 0.003 var(--surface-hue));
		--ink-tertiary: oklch(0.6 0.0025 var(--surface-hue));
		--rule: oklch(0.9 0.002 var(--surface-hue));

		--accent: oklch(0.66 0.19 45);
		--mark-orange: #ff6700;

		--working: oklch(0.68 0.2 45);
		--working-soft: oklch(0.96 0.04 50);
		--good: oklch(0.53 0.13 150);
		--good-soft: oklch(0.95 0.04 150);
		--warning: oklch(0.58 0.13 70);
		--warning-soft: oklch(0.96 0.05 85);
		--critical: oklch(0.55 0.19 27);
		--critical-soft: oklch(0.96 0.03 27);
	}
	@media (prefers-color-scheme: dark) {
		:root {
			--ground: oklch(0.19 0.004 var(--surface-hue));
			--card: oklch(0.235 0.005 var(--surface-hue));
			--document: oklch(0.27 0.005 var(--surface-hue));
			--hover: oklch(0.28 0.006 var(--surface-hue));
			--active: oklch(0.32 0.007 var(--surface-hue));
			--ink: oklch(0.93 0.003 var(--surface-hue));
			--ink-secondary: oklch(0.72 0.004 var(--surface-hue));
			--ink-tertiary: oklch(0.58 0.004 var(--surface-hue));
			--rule: oklch(0.33 0.006 var(--surface-hue));
			--working-soft: oklch(0.33 0.06 50);
			--good-soft: oklch(0.3 0.05 150);
			--warning-soft: oklch(0.32 0.05 85);
			--critical-soft: oklch(0.32 0.06 27);
			--good: oklch(0.75 0.14 150);
			--warning: oklch(0.8 0.13 80);
			--critical: oklch(0.7 0.17 27);
		}
	}

	* { box-sizing: border-box; }
	html, body { height: 100%; }
	body {
		margin: 0;
		background: var(--ground);
		color: var(--ink);
		font: var(--size-ui)/1.45 var(--face-ui);
		-webkit-font-smoothing: antialiased;
	}
	.shell {
		display: grid;
		grid-template-columns: 216px minmax(0, 1fr);
		gap: var(--pad);
		padding: var(--pad);
		min-height: 100%;
		max-width: 1280px;
		margin: 0 auto;
	}
	@media (max-width: 860px) {
		.shell { grid-template-columns: minmax(0, 1fr); }
	}

	/* ── the rail ─────────────────────────────────────────────────────── */
	.rail { display: flex; flex-direction: column; gap: var(--gap); }
	.brand { display: flex; align-items: center; gap: 8px; padding: 4px 6px 10px; }
	.brand .dot {
		width: 9px; height: 9px; border-radius: 999px; background: var(--mark-orange);
		flex: 0 0 auto;
	}
	.brand .name { font-weight: 600; font-size: var(--size-subheading); }
	.brand .live {
		margin-left: auto; font-size: var(--size-micro); color: var(--ink-tertiary);
		text-transform: uppercase; letter-spacing: 0.04em;
	}
	.brand .live.on { color: var(--good); }
	.nav { display: flex; flex-direction: column; gap: 2px; }
	.nav button {
		appearance: none; border: 0; background: transparent; color: var(--ink-secondary);
		font: inherit; text-align: left; padding: 7px 10px; border-radius: var(--chip-radius);
		cursor: pointer; display: flex; gap: 8px; align-items: center;
	}
	.nav button:hover { background: var(--hover); color: var(--ink); }
	.nav button[aria-current="true"] { background: var(--active); color: var(--ink); font-weight: 500; }
	.nav .count { margin-left: auto; font-size: var(--size-micro); color: var(--ink-tertiary); font-variant-numeric: tabular-nums; }

	.railfoot { margin-top: auto; padding: 10px; border-radius: var(--box-radius); background: var(--card); }
	.railfoot .k { font-size: var(--size-micro); color: var(--ink-tertiary); text-transform: uppercase; letter-spacing: 0.04em; }
	.railfoot .v { font-size: var(--size-small); color: var(--ink-secondary); margin-top: 2px; overflow-wrap: anywhere; }

	/* ── the pane ─────────────────────────────────────────────────────── */
	.pane { display: flex; flex-direction: column; gap: var(--pad); min-width: 0; }
	.pane > header { display: flex; align-items: baseline; gap: 10px; padding: 2px 2px 0; }
	.pane h1 { margin: 0; font-size: var(--size-title); font-weight: 600; letter-spacing: -0.01em; }
	.pane .sub { color: var(--ink-tertiary); font-size: var(--size-small); }

	.section { display: flex; flex-direction: column; gap: 8px; }
	.section > h2 {
		margin: 0; padding: 0 2px; font-size: var(--size-label); font-weight: 500;
		color: var(--ink-tertiary); text-transform: uppercase; letter-spacing: 0.05em;
	}

	/* a filled box hugging its content: never stretched, never bordered */
	.box {
		background: var(--card);
		border-radius: var(--box-radius);
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.box.head { flex-direction: row; align-items: center; gap: 10px; }
	.box .title { font-weight: 500; overflow-wrap: anywhere; }
	.box .desc { color: var(--ink-secondary); font-size: var(--size-small); overflow-wrap: anywhere; }
	.box .answer {
		white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--size-small);
		background: var(--hover); border-radius: var(--tile-radius); padding: 8px 10px;
	}
	.box .meta { display: flex; gap: 10px; flex-wrap: wrap; color: var(--ink-tertiary); font-size: var(--size-micro); }
	.box .meta .mono { font-family: var(--face-mono); }
	.box .stop {
		margin-left: auto; appearance: none; border: 0; cursor: pointer; font: inherit;
		font-size: var(--size-label); padding: 4px 10px; border-radius: var(--chip-radius);
		background: var(--hover); color: var(--ink-secondary);
	}
	.box .stop:hover { background: var(--active); color: var(--ink); }

	.pill {
		font-size: var(--size-micro); padding: 2px 8px; border-radius: 999px;
		background: var(--hover); color: var(--ink-secondary); text-transform: lowercase;
		flex: 0 0 auto;
	}
	.pill.running, .pill.working { background: var(--working-soft); color: var(--working); }
	.pill.done, .pill.idle { background: var(--good-soft); color: var(--good); }
	.pill.queued, .pill.waiting { background: var(--warning-soft); color: var(--warning); }
	.pill.failed, .pill.cancelled, .pill.stopped { background: var(--critical-soft); color: var(--critical); }

	.empty {
		padding: 14px; border-radius: var(--box-radius); background: var(--card);
		color: var(--ink-tertiary); font-size: var(--size-small);
	}

	.list { display: flex; flex-direction: column; gap: 4px; }
	.row {
		display: flex; align-items: center; gap: 10px; padding: 7px 10px;
		border-radius: var(--tile-radius); background: var(--card); cursor: default;
	}
	.row:hover { background: var(--hover); }
	.row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.row .seq { margin-left: auto; color: var(--ink-tertiary); font-size: var(--size-micro); font-variant-numeric: tabular-nums; }

	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--gap); }
	.stat { background: var(--card); border-radius: var(--box-radius); padding: 12px 14px; }
	.stat .k { font-size: var(--size-micro); color: var(--ink-tertiary); text-transform: uppercase; letter-spacing: 0.04em; }
	.stat .v { font-size: var(--size-heading); font-variant-numeric: tabular-nums; margin-top: 2px; }
	.stat .note { font-size: var(--size-micro); color: var(--ink-tertiary); }

	.hidden { display: none !important; }
	.mono { font-family: var(--face-mono); font-size: var(--size-micro); }
</style>
</head>
<body>
<div class="shell">
	<aside class="rail">
		<div class="brand">
			<span class="dot" aria-hidden="true"></span>
			<span class="name">${escapeHtml(options.agent)}</span>
			<span class="live" id="live">connecting</span>
		</div>
		<nav class="nav" id="nav" aria-label="Sections">
			<button data-view="work" aria-current="true">Work <span class="count" id="count-work"></span></button>
			<button data-view="threads">Threads <span class="count" id="count-threads"></span></button>
			<button data-view="hands">Hands <span class="count" id="count-hands"></span></button>
			<button data-view="plan">Scratchpad <span class="count" id="count-plan"></span></button>
			<button data-view="metrics">Metrics</button>
		</nav>
		<div class="railfoot">
			<div class="k">Brain</div>
			<div class="v mono" id="identity">—</div>
			<div class="k" style="margin-top:8px">Uptime</div>
			<div class="v" id="uptime">—</div>
		</div>
	</aside>

	<main class="pane">
		<header>
			<h1 id="heading">Work</h1>
			<span class="sub" id="subheading"></span>
		</header>
		<div id="content"></div>
	</main>
</div>

<script>
(function () {
	var BASE = ${JSON.stringify(base)};
	var token = new URLSearchParams(location.search).get("token") || "";
	var state = null;
	var view = "work";

	function api(path, init) {
		return fetch(BASE + path, Object.assign({}, init, {
			headers: Object.assign({ "authorization": "Bearer " + token }, (init && init.headers) || {})
		}));
	}

	function el(tag, cls, text) {
		var node = document.createElement(tag);
		if (cls) node.className = cls;
		if (text !== undefined && text !== null) node.textContent = String(text);
		return node;
	}

	function pill(status) {
		return el("span", "pill " + (status || ""), status || "unknown");
	}

	function ago(at) {
		if (!at) return "";
		var seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
		if (seconds < 60) return seconds + "s ago";
		if (seconds < 3600) return Math.round(seconds / 60) + "m ago";
		return Math.round(seconds / 3600) + "h ago";
	}

	function setCounts() {
		document.getElementById("count-work").textContent = state.tasks.filter(function (t) {
			return t.status === "running" || t.status === "queued";
		}).length || "";
		document.getElementById("count-threads").textContent = state.threads.length || "";
		document.getElementById("count-hands").textContent = state.hands.length || "";
		document.getElementById("count-plan").textContent = state.scratchpad.length || "";
	}

	function taskBox(task) {
		var box = el("div", "box");
		var head = el("div", "box head");
		head.appendChild(el("span", "title", task.title));
		head.appendChild(pill(task.status));
		if (task.status === "running" || task.status === "queued") {
			var stop = el("button", "stop", "Stop");
			stop.addEventListener("click", function () {
				stop.disabled = true;
				api("/api/tasks/" + encodeURIComponent(task.id) + "/stop", { method: "POST" });
			});
			head.appendChild(stop);
		}
		box.appendChild(head);
		if (task.description) box.appendChild(el("div", "desc", task.description));
		var answer = task.error || task.result;
		if (answer) box.appendChild(el("div", "answer", answer));
		var meta = el("div", "meta");
		if (task.endpointId) meta.appendChild(el("span", "mono", task.endpointId));
		if (task.workerId) meta.appendChild(el("span", "mono", task.workerId));
		meta.appendChild(el("span", null, "updated " + ago(task.updatedAt)));
		box.appendChild(meta);
		return box;
	}

	function section(title, nodes) {
		var wrap = el("section", "section");
		if (title) wrap.appendChild(el("h2", null, title));
		if (nodes.length === 0) wrap.appendChild(el("div", "empty", "Nothing here."));
		nodes.forEach(function (node) { wrap.appendChild(node); });
		return wrap;
	}

	function render() {
		var content = document.getElementById("content");
		content.textContent = "";
		var heading = document.getElementById("heading");
		var sub = document.getElementById("subheading");

		if (view === "work") {
			heading.textContent = "Work";
			sub.textContent = "What the brain is doing, and what it did.";
			var running = state.tasks.filter(function (t) { return t.status === "running" || t.status === "queued"; });
			var finished = state.tasks.filter(function (t) { return t.status !== "running" && t.status !== "queued"; }).reverse();
			content.appendChild(section("In flight", running.map(taskBox)));
			content.appendChild(section("Recently finished", finished.slice(0, 12).map(taskBox)));
		}

		if (view === "threads") {
			heading.textContent = "Threads";
			sub.textContent = "Every conversation, newest first.";
			var list = el("div", "list");
			state.threads.forEach(function (thread) {
				var row = el("div", "row");
				row.appendChild(el("span", "name", thread.name || thread.id));
				row.appendChild(pill(thread.status));
				row.appendChild(el("span", "seq", thread.seq + " · " + ago(thread.lastEventAt)));
				list.appendChild(row);
			});
			content.appendChild(section(null, [list]));
		}

		if (view === "hands") {
			heading.textContent = "Hands";
			sub.textContent = "Where the work runs.";
			var grid = el("div", "grid");
			state.hands.forEach(function (hand) {
				var box = el("div", "box");
				var head = el("div", "box head");
				head.appendChild(el("span", "title", hand.name || hand.endpointId));
				head.appendChild(pill(hand.connected ? "running" : "stopped"));
				box.appendChild(head);
				box.appendChild(el("div", "meta", [
					"exec " + (hand.capabilities.exec ? "yes" : "no"),
					" · fs " + hand.capabilities.fs,
					" · git " + (hand.capabilities.git ? "yes" : "no"),
					" · running " + hand.running + "/" + hand.policy.maxConcurrent
				].join("")));
				var roots = el("div", "mono", (hand.policy.roots || []).join("\\n"));
				box.appendChild(roots);
				grid.appendChild(box);
			});
			content.appendChild(section(null, state.hands.length ? [grid] : []));
		}

		if (view === "plan") {
			heading.textContent = "Scratchpad";
			sub.textContent = "The brain's own lists, across every conversation.";
			var open = state.scratchpad;
			var outstanding = open.filter(function (item) { return item.kind === "outstanding"; });
			var planned = open.filter(function (item) { return item.kind === "planned"; });
			content.appendChild(section("Outstanding", outstanding.map(function (item) {
				var box = el("div", "box");
				box.appendChild(el("div", "title", item.text));
				box.appendChild(el("div", "meta", [item.id, item.threadId ? "thread " + item.threadId : "", ago(item.createdAt)].join(" · ")));
				return box;
			})));
			content.appendChild(section("Planned", planned.map(function (item) {
				var box = el("div", "box");
				box.appendChild(el("div", "title", item.text));
				box.appendChild(el("div", "meta", [item.id, ago(item.createdAt)].join(" · ")));
				return box;
			})));
		}

		if (view === "metrics") {
			heading.textContent = "Metrics";
			sub.textContent = "Counters and gauges since this brain started.";
			var grid = el("div", "grid");
			var entries = Object.keys(state.metrics.counters || {}).sort();
			entries.slice(0, 40).forEach(function (key) {
				var stat = el("div", "stat");
				stat.appendChild(el("div", "k", key.replace(/^mir_/, "").replace(/_total$/, "")));
				stat.appendChild(el("div", "v", state.metrics.counters[key]));
				grid.appendChild(stat);
			});
			content.appendChild(section(null, entries.length ? [grid] : []));
		}

		setCounts();
		document.getElementById("identity").textContent = state.identity || "—";
		document.getElementById("uptime").textContent = state.startedAt ? ago(state.startedAt).replace(" ago", "") : "—";
	}

	document.getElementById("nav").addEventListener("click", function (event) {
		var button = event.target.closest("button[data-view]");
		if (!button) return;
		view = button.getAttribute("data-view");
		Array.prototype.forEach.call(document.querySelectorAll("#nav button"), function (other) {
			other.setAttribute("aria-current", other === button ? "true" : "false");
		});
		render();
	});

	function setLive(on) {
		var live = document.getElementById("live");
		live.textContent = on ? "live" : "offline";
		live.className = "live" + (on ? " on" : "");
	}

	function load() {
		return api("/api/state").then(function (res) {
			if (!res.ok) throw new Error("state " + res.status);
			return res.json();
		}).then(function (payload) {
			state = payload;
			render();
		});
	}

	load().then(function () {
		var events = new EventSource(BASE + "/api/events?token=" + encodeURIComponent(token));
		events.addEventListener("open", function () { setLive(true); });
		events.addEventListener("error", function () { setLive(false); });
		// One event type: the whole state, small enough to send whole. A dashboard
		// that renders from a diff is a dashboard with a bug about diffs.
		events.addEventListener("state", function (message) {
			try {
				state = JSON.parse(message.data);
				render();
				setLive(true);
			} catch (error) { /* a torn frame: the next one is whole */ }
		});
	}).catch(function () {
		setLive(false);
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
