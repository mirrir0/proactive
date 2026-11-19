/**
 * html.ts — the dashboard, rendered on the server.
 *
 * **Not a single-page app.** Every view is a URL — `/`, `/threads`,
 * `/threads/<id>`, `/hands`, `/scratchpad`, `/metrics` — and every link is an
 * `<a href>`: a thread can be bookmarked, pasted to somebody, opened in a new tab,
 * and reloaded into the same view. A dashboard you cannot link to is a dashboard
 * you have to describe.
 *
 * The markup is rendered here, on the brain, so what arrives is the page. The
 * script does one thing: keep it current. One `EventSource` swaps the section for
 * its freshly rendered fragment when the state changes, and appends entries when a
 * thread page is open. Nothing navigates without the browser doing it.
 *
 * The look is the product's, not a new one: Between's surfaces and inks, the
 * soft-corner radii, the status fills, the type steps — copied as values so the
 * brain needs no stylesheet dependency. A frame on the ground, the rail inside its
 * left edge, and the content as a rounded panel inset from it.
 */

import type { DashboardState } from "./server.ts";
import { areaChart, barChart, lineChart, pieChart, radarChart, radialChart, type Point } from "./charts.ts";

export type DashboardView = "work" | "threads" | "thread" | "hands" | "scratchpad" | "metrics";

export interface PageOptions {
	readonly agent: string;
	readonly view: DashboardView;
	/** The thread being shown, for `view: "thread"`. */
	readonly threadId?: string;
	/** The worker whose detail the right panel shows, when one is picked. */
	readonly selectedTask?: string;
	/** Whether the workers panel is showing. In the URL, so a reload keeps it. */
	readonly workersOpen?: boolean;
	readonly state: DashboardState;
	/** Entries for a thread page, oldest first. */
	readonly entries?: ReadonlyArray<DashboardEntry>;
}

export interface DashboardEntry {
	seq: number;
	at: number;
	kind: string;
	role?: string;
	text?: string;
	note?: string;
	title?: string;
	toolName?: string;
	args?: unknown;
	op?: string;
	endpointId?: string;
	workerId?: string;
	ok?: boolean;
	isError?: boolean;
	data?: Record<string, unknown>;
}

/** The token, carried on every link so a copied URL still works. */
let tokenForLinks = "";

export function renderPage(options: PageOptions): string {
	const view = options.view;
	return `<!doctype html>
<html lang="en" data-radius="soft" data-surface="cool" data-accent="orange">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle(options))} — ${escapeHtml(options.agent)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="frame${view === "thread" && options.workersOpen !== false ? " open" : ""}">
	<aside class="rail">
		<a class="brand" href="${withToken("/")}">
			<span class="dot" aria-hidden="true"></span>
			<span class="name">${escapeHtml(options.agent)}</span>
		</a>
		${renderNav(options)}
		<div class="railfoot">
			<div class="k">Brain</div>
			<div class="v mono">${escapeHtml(options.state.identity ?? "—")}</div>
			<div class="k" style="margin-top:8px">Up since</div>
			<div class="v">${escapeHtml(ago(options.state.startedAt))}</div>
		</div>
	</aside>
	<main class="pane">
		<header>
			<h1>${escapeHtml(pageHeading(options))}</h1>
			<span class="sub">${escapeHtml(pageSub(options))}</span>
			${view === "thread" ? threadSource(options) : ""}
			${view === "thread" ? pill(threadStatusOf(options)) : ""}
			${
				view === "thread" && options.workersOpen === false
					? `<a class="collapse" href="${withToken(
							`/threads/${encodeURIComponent(options.threadId ?? "")}?workers=1`,
						)}">← workers (${options.state.tasks.filter((task) => task.threadId === options.threadId).length})</a>`
					: ""
			}
		</header>
		<div id="content" data-view="${view}">${view === "thread" ? renderChat(options) : renderSection(options)}</div>
	</main>
	${view === "thread" && options.workersOpen !== false ? renderWorkers(options) : ""}
</div>
<script>
(function () {
	var TOKEN = ${JSON.stringify(tokenForLinks)};
	var view = ${JSON.stringify(view)};
	var threadId = ${JSON.stringify(options.threadId ?? "")};
	var content = document.getElementById("content");

	// One stream: state for the counts and the section, entries for a thread page.
	var query = "/api/events?token=" + encodeURIComponent(TOKEN) +
		(threadId ? "&thread=" + encodeURIComponent(threadId) + "&since=" + lastSeq() : "");
	var stream = new EventSource(query);

	stream.addEventListener("state", function (message) {
		try {
			var state = JSON.parse(message.data);
			updateCounts(state);
			// The section is rendered by the server, so the swap is markup, not a
			// client-side renderer: links inside it are links. A thread page is the
			// chat, and the chat is appended entry by entry — swapping it would throw
			// away the scroll position somebody is reading at.
			if (view === "thread") return;
			fetch("/partial/" + view + "?token=" + encodeURIComponent(TOKEN), { headers: { authorization: "Bearer " + TOKEN } })
				.then(function (res) { return res.ok ? res.text() : null; })
				.then(function (html) { if (html !== null) content.innerHTML = html; })
				.catch(function () {});
		} catch (error) {}
	});

	stream.addEventListener("entry", function (message) {
		var payload = JSON.parse(message.data);
		if (payload.threadId !== threadId) return;
		var kind = payload.entry && payload.entry.kind;
		// Same rule as the server's: the chat is the conversation, so a tool call
		// arriving live is not drawn here either.
		if (kind === "tool_call" || kind === "tool_result" || kind === "hand" || kind === "status") return;
		if (payload.entry.workerId) return;
		appendEntry(payload.entry);
	});

	function lastSeq() {
		var nodes = document.querySelectorAll("#entries [data-seq]");
		if (nodes.length === 0) return 0;
		return Number(nodes[nodes.length - 1].getAttribute("data-seq")) || 0;
	}

	function updateCounts(state) {
		var counts = {
			"count-work": state.tasks.filter(function (t) { return t.status === "running" || t.status === "queued"; }).length,
			"count-threads": state.threads.length,
			"count-hands": state.hands.length,
			"count-scratchpad": state.scratchpad.length
		};
		Object.keys(counts).forEach(function (id) {
			var node = document.getElementById(id);
			if (node) node.textContent = counts[id] || "";
		});
	}

	function appendEntry(entry) {
		var box = document.getElementById("entries");
		if (!box) return;
		var row = document.createElement("div");
		row.setAttribute("data-seq", String(entry.seq));
		row.className = "entry " + entryClass(entry);
		var who = document.createElement("span");
		who.className = "who";
		who.textContent = entryWho(entry);
		row.appendChild(who);
		row.appendChild(document.createTextNode(entryText(entry)));
		box.appendChild(row);
		box.scrollTop = box.scrollHeight;
	}

	function entryClass(entry) {
		if (entry.kind === "text") return entry.role === "user" ? "them" : "me";
		if (entry.kind === "status" || entry.kind === "title") return "said";
		if (entry.kind === "stop") return "failed";
		if (entry.kind === "app") return "work";
		return "mono";
	}

	function entryWho(entry) {
		if (entry.kind === "text") return entry.role === "user" ? "them" : "mir";
		if (entry.kind === "tool_call") return "tool";
		if (entry.kind === "tool_result") return entry.isError ? "tool · failed" : "tool · result";
		if (entry.kind === "hand") return "hand";
		return "";
	}

	function entryText(entry) {
		if (entry.kind === "text") return entry.text || "";
		if (entry.kind === "tool_call") return entry.toolName || "";
		if (entry.kind === "tool_result") return entry.isError ? "failed" : "ok";
		if (entry.kind === "hand") return (entry.op || "") + (entry.endpointId ? " on " + entry.endpointId : "");
		if (entry.kind === "app") return (entry.data && entry.data.title) || "work";
		return entry.note || entry.title || "";
	}
})();
</script>
</body>
</html>`;
}

/** One section, as the page and the live swap both render it. */
export function renderSection(options: PageOptions): string {
	const state = options.state;
	if (options.view === "work") {
		const inFlight = state.tasks.filter((task) => task.status === "running" || task.status === "queued");
		const finished = state.tasks.filter((task) => task.status !== "running" && task.status !== "queued");
		return [
			section("In flight", inFlight.map(taskBox)),
			section("Recently finished", finished.slice(0, 12).map(taskBox)),
		].join("");
	}
	if (options.view === "threads") {
		return section(
			null,
			state.threads.length === 0
				? ['<div class="empty">No conversations yet.</div>']
				: [
						`<div class="list">${state.threads
							.map(
								(thread) => `<a class="row threadsrow" href="${withToken(`/threads/${encodeURIComponent(thread.id)}`)}">
					<span class="name">${escapeHtml(thread.name || thread.id)}</span>
					${pill(thread.status)}
					<span class="seq">${thread.seq} · ${escapeHtml(ago(thread.lastEventAt))}</span>
				</a>`,
							)
							.join("")}</div>`,
					],
		);
	}
	if (options.view === "thread") {
		return ""; // the pane beside the content is the thread
	}
	if (options.view === "hands") {
		return state.hands.length === 0
			? section(null, ['<div class="empty">No hands connected.</div>'])
			: section(
					null,
					[
						`<div class="grid">${state.hands
							.map(
								(hand) => `<div class="box">
					<div class="box head"><span class="title">${escapeHtml(hand.name || hand.endpointId)}</span>${pill(hand.connected ? "running" : "stopped")}</div>
					<div class="meta"><span class="mono">${escapeHtml(hand.endpointId)}</span><span>exec ${hand.capabilities.exec ? "yes" : "no"}</span><span>fs ${escapeHtml(String(hand.capabilities.fs))}</span><span>running ${hand.running}/${hand.policy.maxConcurrent}</span></div>
					<div class="mono">${hand.policy.roots.map((root) => escapeHtml(root)).join("<br>")}</div>
				</div>`,
							)
							.join("")}</div>`,
					],
				);
	}
	if (options.view === "scratchpad") {
		const outstanding = state.scratchpad.filter((item) => item.kind === "outstanding");
		const planned = state.scratchpad.filter((item) => item.kind === "planned");
		const item = (entry: DashboardState["scratchpad"][number]): string =>
			`<div class="box"><div class="title">${escapeHtml(entry.text)}</div><div class="meta"><span class="mono">${escapeHtml(entry.id)}</span>${
				entry.threadId ? `<a class="linklike" href="${withToken(`/threads/${encodeURIComponent(entry.threadId)}`)}">thread</a>` : ""
			}<span>${escapeHtml(ago(entry.createdAt))}</span></div></div>`;
		return [
			section("Outstanding", outstanding.length === 0 ? ['<div class="empty">Nothing in flight.</div>'] : outstanding.map(item)),
			section("Planned", planned.length === 0 ? ['<div class="empty">Nothing planned.</div>'] : planned.map(item)),
		].join("");
	}
	return metricsCharts(state);
}

/**
 * The metrics page: the six chart forms shadcn ships, drawn from the brain's own
 * numbers.
 *
 * shadcn's charts are Recharts wrappers — a React tree and a bundler — so what is
 * borrowed is the language they encode: the `--chart-1..5` palette, a grid that is
 * horizontal-only and dashed `3 6`, bars with a 4px radius, a 2px line with no
 * dots, an area with a gradient under it. The forms are the same six; the renderer
 * is SVG on the server, so the page is still one document with real links.
 */
function metricsCharts(state: DashboardState): string {
	const counters = state.metrics.counters;
	const history = state.history;
	const labels = history.map((sample) => new Date(sample.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
	void labels;

	// Time series: what the brain was doing, sampled by the dashboard.
	const inFlight = history.map((sample) => sample.inFlight);
	const threads = history.map((sample) => sample.threads);
	const turns = history.map((sample) => sample.turns);

	// Counters, by the group in their name: mir_router_*, mir_worker_*, mir_hands_*.
	const groups = new Map<string, number>();
	for (const [key, value] of Object.entries(counters)) {
		const group = key.replace(/^mir_/, "").split("_")[0] ?? "other";
		groups.set(group, (groups.get(group) ?? 0) + value);
	}
	const groupPoints: Point[] = [...groups.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([label, value]) => ({ label, value }));

	const topCounters: Point[] = Object.entries(counters)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 8)
		.map(([key, value]) => ({ label: key.replace(/^mir_/, "").replace(/_total$/, ""), value }));

	const gauges = state.metrics.gauges;
	const inFlightNow = inFlight.at(-1) ?? 0;
	const capacity = Math.max(1, state.tasks.length);
	const gaugesShown: Point[] = [
		{ label: "work", value: Math.min(1, inFlightNow / Math.max(1, capacity)) },
		{ label: "hands", value: Math.min(1, state.hands.filter((hand) => hand.connected).length / Math.max(1, state.hands.length)) },
		{ label: "threads", value: Math.min(1, state.threads.filter((thread) => thread.status === "running").length / Math.max(1, state.threads.length)) },
		{ label: "load", value: Math.min(1, (gauges["mir_hands_running"] ?? 0) / Math.max(1, state.hands.length * 4)) },
	];

	const charts = [
		lineChart(
			[
				{ label: "in flight", values: inFlight.length === 0 ? [0, 0] : inFlight },
				{ label: "threads", values: threads.length === 0 ? [0, 0] : threads, color: 1, dashed: true },
			],
			"Work over time",
			"in flight, and conversations seen — sampled while this page is open",
		),
		areaChart([{ label: "turns", values: turns.length === 0 ? [0, 0] : turns }], "Router turns", "cumulative, since this brain started"),
		barChart(topCounters, "What happens most", "the counters with the largest totals"),
		pieChart(groupPoints, "By part of the brain", "router, worker, hands, mcp, dashboard"),
		radarChart(groupPoints, "Shape of the work", "the same groups, relative to each other"),
		radialChart(gaugesShown, "How full", "work, hands, threads and hand load, as a share"),
	];

	const rows = Object.entries(counters)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 40)
		.map(([key, value]) => `<div class="stat"><div class="k">${escapeHtml(key.replace(/^mir_/, "").replace(/_total$/, ""))}</div><div class="v">${value}</div></div>`)
		.join("");

	return [
		`<section class="section"><div class="charts">${charts.join("")}</div></section>`,
		section("Counters", [rows === "" ? '<div class="empty">No counters yet.</div>' : `<div class="grid">${rows}</div>`]),
	].join("");
}

/**
 * A thread's workers, on the right.
 *
 * The chat is the main area, because that is what a person follows; the workers
 * are beside it, because that is what the chat set in motion. Clicking one opens
 * its detail in place — a real URL (`?task=…`), so the state of one worker can be
 * sent to somebody, and the chat keeps its scroll while you look.
 */
function renderWorkers(options: PageOptions): string {
	const threadId = options.threadId ?? "";
	const workers = options.state.tasks.filter((task) => task.threadId === options.threadId);
	const selected = workers.find((task) => task.id === options.selectedTask) ?? (options.selectedTask === undefined ? undefined : undefined);
	const rows = workers
		.map(
			(task) => `<a class="worker${task.id === selected?.id ? " on" : ""}" href="${withToken(
				`/threads/${encodeURIComponent(threadId)}?task=${encodeURIComponent(task.id)}`,
			)}">
				<span class="workertitle">${escapeHtml(task.title)}</span>
				${pill(task.status)}
			</a>`,
		)
		.join("");
	const activity =
		selected === undefined
			? ""
			: (options.entries ?? [])
					.filter((entry) => entry.workerId === (selected.workerId ?? selected.id) && entry.kind !== "text")
					.map((entry) => workerActivity(entry))
					.join("");
	const detail =
		selected === undefined
			? ""
			: `<div class="workerdetail">
				<div class="workerhead"><span class="title">${escapeHtml(selected.title)}</span>${pill(selected.status)}</div>
				<div class="desc">${escapeHtml(selected.description)}</div>
				${selected.error ?? selected.result === undefined ? "" : `<div class="answer">${escapeHtml(selected.error ?? selected.result ?? "")}</div>`}
				<div class="meta">
					<span class="mono">${escapeHtml(selected.id)}</span>
					${selected.endpointId === undefined ? "" : `<span class="mono">${escapeHtml(selected.endpointId)}</span>`}
					<span>${escapeHtml(ago(selected.updatedAt))}</span>
				</div>
				${activity === "" ? "" : `<div class="activity"><div class="k">Activity</div>${activity}</div>`}
			</div>`;
	return `<aside class="workers" aria-label="Workers">
		<header class="workershead">
			<span>Workers</span><span class="count">${workers.length}</span>
			<a class="collapse" href="${withToken(`/threads/${encodeURIComponent(threadId)}?workers=0`)}" aria-label="Hide workers">→</a>
		</header>
		<div class="workerlist">${workers.length === 0 ? '<div class="railnote">Nothing started here yet.</div>' : rows}</div>
		${detail}
	</aside>`;
}

/** The channel a thread came from, and the words that opened it. */
function threadSource(options: PageOptions): string {
	const thread = options.state.threads.find((candidate) => candidate.id === options.threadId);
	const channel = thread?.channelId;
	const first = (options.entries ?? []).find((entry) => entry.kind === "text" && entry.role === "user")
		?? (options.entries ?? []).find((entry) => entry.kind === "status" && (entry.note ?? "").startsWith("dispatched: "));
	const said = first?.text ?? first?.note?.replace(/^dispatched: /, "");
	return `${channel === undefined ? "" : `<span class="pill">${escapeHtml(channel)}</span>`}${
		said === undefined ? "" : `<span class="opening">“${escapeHtml(said.length > 90 ? `${said.slice(0, 90)}…` : said)}”</span>`
	}`;
}

/** One line of a worker's activity: a tool call, a skill load, a hand call. */
function workerActivity(entry: DashboardEntry): string {
	if (entry.kind === "tool_call") {
		// A skill is loaded by calling `use_skill`; the thread should say which one,
		// because "it read a skill" and "it read the space skill" are different facts.
		const args = entry.args as { name?: unknown } | undefined;
		const skill = entry.toolName === "use_skill" && typeof args?.name === "string" ? args.name : undefined;
		return `<div class="act">${skill === undefined ? `called ${escapeHtml(entry.toolName ?? "tool")}` : `read skill “${escapeHtml(skill)}”`}</div>`;
	}
	if (entry.kind === "tool_result") return `<div class="act dim">${entry.isError === true ? "failed" : "ok"}</div>`;
	if (entry.kind === "hand") return `<div class="act">${escapeHtml(entry.op ?? "hand")} on ${escapeHtml(entry.endpointId ?? "hand")}</div>`;
	return "";
}

/** The chat itself: the log, oldest first, live. */
function renderChat(options: PageOptions): string {
	// One card per task, at the place the last one was written: a card that was
	// appended again when the work finished is the same card, and drawing both
	// shows a running task that finished three lines ago.
	// The chat is the conversation with the person: what they said, what the
	// assistant answered, the card that opens the work, and a stop. Everything a
	// worker said or did is worker-scoped — its tool calls, its answer, the status
	// lines about it — and it belongs in the panel beside the chat, not in the chat.
	const conversation = (options.entries ?? []).filter(
		(entry) =>
			entry.workerId === undefined &&
			entry.kind !== "tool_call" &&
			entry.kind !== "tool_result" &&
			entry.kind !== "hand" &&
			entry.kind !== "status" &&
			// A rename is the thread's heading, not something said in it.
			entry.kind !== "title",
	);
	const entries = conversation.filter((entry, index, all) => {
		if (entry.kind !== "app") return true;
		const taskId = entry.data?.taskId;
		if (typeof taskId !== "string") return true;
		let last = -1;
		for (let i = 0; i < all.length; i += 1) {
			const other = all[i]!;
			if (other.kind === "app" && other.data?.taskId === taskId) last = i;
		}
		return last === index;
	});
	return `<div class="entries" id="entries">${
		entries.length === 0 ? '<div class="empty">Nothing said here yet.</div>' : entries.map((entry) => entryHtml(entry, options.threadId)).join("")
	}</div>`;
}

/** One entry, as the pane draws it. */
export function entryHtml(entry: DashboardEntry, threadId?: string): string {
	const who = entryWho(entry);
	const body = escapeHtml(entryText(entry));
	const cls =
		entry.kind === "text"
			? entry.role === "user"
				? "them"
				: "me"
			: entry.kind === "status" || entry.kind === "title"
				? "said"
				: entry.kind === "stop"
					? "failed"
					: entry.kind === "app"
						? "work"
						: "mono";
	// A work card is the way into the worker it is about: the chat says what
	// started, and clicking it opens that worker beside the chat.
	const taskId = typeof entry.data?.taskId === "string" ? entry.data.taskId : undefined;
	if (entry.kind === "app" && taskId !== undefined && threadId !== undefined) {
		return `<a class="entry ${cls}" data-seq="${entry.seq}" href="${withToken(
			`/threads/${encodeURIComponent(threadId)}?task=${encodeURIComponent(taskId)}`,
		)}"><span class="who">${escapeHtml(who === "" ? "work" : who)}</span>${body}</a>`;
	}
	return `<div class="entry ${cls}" data-seq="${entry.seq}">${who === "" ? "" : `<span class="who">${escapeHtml(who)}</span>`}${body}</div>`;
}

function entryWho(entry: DashboardEntry): string {
	if (entry.kind === "text") return entry.role === "user" ? "them" : "mir";
	if (entry.kind === "tool_call") return "tool";
	if (entry.kind === "tool_result") return entry.isError ? "tool · failed" : "tool · result";
	if (entry.kind === "hand") return "hand";
	return "";
}

function entryText(entry: DashboardEntry): string {
	switch (entry.kind) {
		case "text":
			return entry.text ?? "";
		case "tool_call":
			return entry.toolName ?? "";
		case "tool_result":
			return entry.isError ? "failed" : "ok";
		case "hand":
			return `${entry.op ?? ""}${entry.endpointId === undefined ? "" : ` on ${entry.endpointId}`}`;
		case "app": {
			const title = typeof entry.data?.title === "string" ? entry.data.title : "work";
			const status = typeof entry.data?.status === "string" ? ` — ${entry.data.status}` : "";
			return `${title}${status}`;
		}
		default:
			return entry.note ?? entry.title ?? "";
	}
}

function taskBox(task: DashboardState["tasks"][number]): string {
	const answer = task.error ?? task.result;
	const stop =
		task.status === "running" || task.status === "queued"
			? `<button class="stop" data-stop="${escapeHtml(task.id)}">Stop</button>`
			: "";
	return `<div class="box">
		<div class="box head"><span class="title">${escapeHtml(task.title)}</span>${pill(task.status)}${stop}</div>
		${task.description === "" ? "" : `<div class="desc">${escapeHtml(task.description)}</div>`}
		${answer === undefined ? "" : `<div class="answer">${escapeHtml(answer)}</div>`}
		<div class="meta">
			${task.threadId ? `<a class="linklike" href="${withToken(`/threads/${encodeURIComponent(task.threadId)}`)}">open thread</a>` : ""}
			${task.endpointId === undefined ? "" : `<span class="mono">${escapeHtml(task.endpointId)}</span>`}
			<span>updated ${escapeHtml(ago(task.updatedAt))}</span>
		</div>
	</div>`;
}

function renderNav(options: PageOptions): string {
	const view = options.view;
	return `<nav class="nav" aria-label="Sections">
		${navLink("/", "Work", view === "work", countInFlight(options.state))}
		${navLink("/threads", "Threads", view === "threads", options.state.threads.length)}
		${navLink("/hands", "Hands", view === "hands", options.state.hands.length)}
		${navLink("/scratchpad", "Scratchpad", view === "scratchpad", options.state.scratchpad.length)}
		${navLink("/metrics", "Metrics", view === "metrics", null)}
	</nav>`;
}

function navLink(href: string, label: string, current: boolean, count: number | null): string {
	return `<a class="navlink" href="${withToken(href)}"${current ? ' aria-current="page"' : ""}>${escapeHtml(label)}${
		count === null || count === 0 ? "" : `<span class="count" id="count-${label.toLowerCase()}">${count}</span>`
	}</a>`;
}

function section(title: string | null, blocks: string[]): string {
	return `<section class="section">${title === null ? "" : `<h2>${escapeHtml(title)}</h2>`}${blocks.join("")}</section>`;
}

function pill(status: string): string {
	return `<span class="pill ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function countInFlight(state: DashboardState): number {
	return state.tasks.filter((task) => task.status === "running" || task.status === "queued").length;
}

function pageTitle(options: PageOptions): string {
	if (options.view === "thread") return threadName(options);
	return pageHeading(options);
}

function pageHeading(options: PageOptions): string {
	switch (options.view) {
		case "threads":
			return "Threads";
		case "thread":
			return threadName(options);
		case "hands":
			return "Hands";
		case "scratchpad":
			return "Scratchpad";
		case "metrics":
			return "Metrics";
		default:
			return "Work";
	}
}

function pageSub(options: PageOptions): string {
	switch (options.view) {
		case "threads":
			return "Every conversation, newest first.";
		case "thread":
			return "The log, as it happens.";
		case "hands":
			return "Where the work runs.";
		case "scratchpad":
			return "The brain's own lists, across every conversation.";
		case "metrics":
			return "Counters and gauges since this brain started.";
		default:
			return "What the brain is doing, and what it did.";
	}
}

function threadName(options: PageOptions): string {
	const thread = options.state.threads.find((candidate) => candidate.id === options.threadId);
	const name = thread?.name;
	// A channel-minted name (`http-…`, `http-http-…`) is a placeholder, not a title:
	// the first thing the person said is what the conversation is.
	if (name !== undefined && !/^(http|terminal|queue|api)-/.test(name)) return name;
	const first = (options.entries ?? []).find((entry) => entry.kind === "text" && entry.role === "user");
	if (first?.text !== undefined) {
		const said = first.text.replace(/\s+/g, " ").trim();
		return said.length > 52 ? `${said.slice(0, 52)}…` : said;
	}
	// A channel that does not log the person's words still logged what it started:
	// the dispatch note is the next best title a thread has.
	const dispatched = (options.entries ?? []).find((entry) => entry.kind === "status" && (entry.note ?? "").startsWith("dispatched: "));
	if (dispatched?.note !== undefined) {
		const said = dispatched.note.slice("dispatched: ".length).replace(/\s+/g, " ").trim();
		return said.length > 52 ? `${said.slice(0, 52)}…` : said;
	}
	return name ?? options.threadId ?? "Thread";
}

function threadStatusOf(options: PageOptions): string {
	const thread = options.state.threads.find((candidate) => candidate.id === options.threadId);
	return thread?.status ?? "unknown";
}

/** Every link carries the token, so a copied URL opens the same page. */
export function setLinkToken(token: string): void {
	tokenForLinks = token;
}

function withToken(path: string): string {
	const join = path.includes("?") ? "&" : "?";
	return `${path}${join}token=${encodeURIComponent(tokenForLinks)}`;
}

function ago(at: number | undefined): string {
	if (at === undefined || at === 0) return "—";
	const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	return `${Math.round(seconds / 3600)}h ago`;
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

const STYLE = `
	:root {
		color-scheme: light dark;
		--face-ui: "Fira Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
		--face-mono: "Geist Mono", "SF Mono", ui-monospace, monospace;
		--size-micro: 10px; --size-label: 11.5px; --size-small: 12.5px; --size-ui: 13px;
		--size-subheading: 14.5px; --size-heading: 19px; --size-title: 26px;
		--row: 30px; --pad: 16px; --gap: 10px;
		--box-radius: 7px; --chip-radius: 7px; --tile-radius: 5px; --radius: 10px;
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
		--working: oklch(0.68 0.2 45); --working-soft: oklch(0.96 0.04 50);
		--good: oklch(0.53 0.13 150); --good-soft: oklch(0.95 0.04 150);
		--warning: oklch(0.58 0.13 70); --warning-soft: oklch(0.96 0.05 85);
		--critical: oklch(0.55 0.19 27); --critical-soft: oklch(0.96 0.03 27);
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
			--working-soft: oklch(0.33 0.06 50); --good-soft: oklch(0.3 0.05 150);
			--warning-soft: oklch(0.32 0.05 85); --critical-soft: oklch(0.32 0.06 27);
			--good: oklch(0.75 0.14 150); --warning: oklch(0.8 0.13 80); --critical: oklch(0.7 0.17 27);
		}
	}
	* { box-sizing: border-box; }
	html, body { height: 100%; }
	body {
		margin: 0; background: var(--ground); color: var(--ink);
		font: var(--size-ui)/1.45 var(--face-ui); -webkit-font-smoothing: antialiased;
		padding: 10px; height: 100vh;
	}
	.frame {
		display: grid; grid-template-columns: 216px minmax(0, 1fr);
		grid-template-rows: minmax(0, 1fr);
		height: calc(100vh - 20px); max-width: 1320px; margin: 0 auto;
		background: var(--document); border-radius: 12px; overflow: hidden;
	}
	.frame.open { grid-template-columns: 216px minmax(0, 1fr) minmax(320px, 440px); }
	@media (max-width: 1100px) { .frame.open { grid-template-columns: 216px minmax(0, 1fr); } .frame.open .thread { display: none; } }
	@media (max-width: 860px) { .frame, .frame.open { grid-template-columns: minmax(0, 1fr); } .rail { display: none; } }

	.rail { display: flex; flex-direction: column; gap: var(--gap); padding: 14px 10px 14px 12px; min-height: 0; overflow-y: auto; }
	.brand { display: flex; align-items: center; gap: 8px; padding: 4px 8px 10px; text-decoration: none; color: inherit; }
	.brand .dot { width: 9px; height: 9px; border-radius: 999px; background: var(--mark-orange); }
	.brand .name { font-weight: 600; font-size: var(--size-subheading); }
	.nav { display: flex; flex-direction: column; gap: 2px; }
	.navlink {
		display: flex; align-items: center; gap: 8px; padding: 7px 10px;
		border-radius: var(--chip-radius); color: var(--ink-secondary); text-decoration: none;
	}
	.navlink:hover { background: var(--hover); color: var(--ink); }
	.navlink[aria-current="page"] { background: var(--active); color: var(--ink); font-weight: 500; }
	.navlink .count { margin-left: auto; font-size: var(--size-micro); color: var(--ink-tertiary); font-variant-numeric: tabular-nums; }
	.railfoot { margin-top: auto; padding: 10px; border-radius: var(--box-radius); background: var(--card); }
	.railfoot .k { font-size: var(--size-micro); color: var(--ink-tertiary); text-transform: uppercase; letter-spacing: 0.04em; }
	.railfoot .v { font-size: var(--size-small); color: var(--ink-secondary); margin-top: 2px; overflow-wrap: anywhere; }

	.pane {
		display: flex; flex-direction: column; gap: var(--pad); min-width: 0; min-height: 0;
		margin: 8px; padding: 18px 20px 24px; background: var(--card); border-radius: 10px; overflow-y: auto;
	}
	.pane > header { display: flex; align-items: baseline; gap: 10px; }
	.pane h1 { margin: 0; font-size: var(--size-title); font-weight: 600; letter-spacing: -0.01em; }
	.pane .sub { color: var(--ink-tertiary); font-size: var(--size-small); }

	.section { display: flex; flex-direction: column; gap: 8px; }
	.section > h2 { margin: 0; padding: 0 2px; font-size: var(--size-label); font-weight: 500; color: var(--ink-tertiary); text-transform: uppercase; letter-spacing: 0.05em; }

	.box { background: var(--hover); border-radius: var(--box-radius); padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
	.box.head { flex-direction: row; align-items: center; gap: 10px; }
	.box .title { font-weight: 500; overflow-wrap: anywhere; }
	.box .desc { color: var(--ink-secondary); font-size: var(--size-small); overflow-wrap: anywhere; }
	.box .answer { white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--size-small); background: var(--document); border-radius: var(--tile-radius); padding: 8px 10px; }
	.box .meta { display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; color: var(--ink-tertiary); font-size: var(--size-micro); }
	.box .stop, .threadhead .stop {
		margin-left: auto; appearance: none; border: 0; cursor: pointer; font: inherit; font-size: var(--size-label);
		padding: 4px 10px; border-radius: var(--chip-radius); background: var(--card); color: var(--ink-secondary); text-decoration: none;
	}
	.box .stop:hover, .threadhead .stop:hover { background: var(--active); color: var(--ink); }
	.linklike { appearance: none; border: 0; background: transparent; padding: 0; font: inherit; color: var(--ink-tertiary); cursor: pointer; font-size: var(--size-micro); text-decoration: none; }
	.linklike:hover { color: var(--ink); text-decoration: underline; }

	.pill { font-size: var(--size-micro); padding: 2px 8px; border-radius: 999px; background: var(--hover); color: var(--ink-secondary); flex: 0 0 auto; }
	.pill.running, .pill.working { background: var(--working-soft); color: var(--working); }
	.pill.done, .pill.idle { background: var(--good-soft); color: var(--good); }
	.pill.queued, .pill.waiting { background: var(--warning-soft); color: var(--warning); }
	.pill.failed, .pill.cancelled, .pill.stopped { background: var(--critical-soft); color: var(--critical); }

	.empty { padding: 14px; border-radius: var(--box-radius); background: var(--hover); color: var(--ink-tertiary); font-size: var(--size-small); }
	.list { display: flex; flex-direction: column; gap: 4px; }
	.row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: var(--tile-radius); background: var(--hover); text-decoration: none; color: inherit; }
	.row:hover { background: var(--active); }
	.row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.row .seq { margin-left: auto; color: var(--ink-tertiary); font-size: var(--size-micro); font-variant-numeric: tabular-nums; }
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--gap); }
	.stat { background: var(--hover); border-radius: var(--box-radius); padding: 12px 14px; }
	.stat .k { font-size: var(--size-micro); color: var(--ink-tertiary); text-transform: uppercase; letter-spacing: 0.04em; }
	.stat .v { font-size: var(--size-heading); font-variant-numeric: tabular-nums; margin-top: 2px; }

	.railnote { padding: 6px 10px; color: var(--ink-tertiary); font-size: var(--size-small); }

	/* The workers panel: the right column of a thread. */
	.workers {
		display: flex; flex-direction: column; gap: 6px; min-width: 0; min-height: 0;
		margin: 8px 8px 8px 0; padding: 14px 12px; background: var(--card); border-radius: 10px; overflow-y: auto;
	}
	.workershead { display: flex; align-items: baseline; gap: 8px; font-size: var(--size-label); font-weight: 500; color: var(--ink-tertiary); text-transform: uppercase; letter-spacing: 0.05em; }
	.workershead .count { margin-left: auto; font-size: var(--size-micro); }
	.workerlist { display: flex; flex-direction: column; gap: 2px; }
	.worker {
		display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--chip-radius);
		text-decoration: none; color: inherit;
	}
	.worker:hover { background: var(--hover); }
	.worker.on { background: var(--active); }
	.worker .workertitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--size-small); }
	.worker .pill { margin-left: auto; }
	.workerdetail { margin-top: 8px; padding: 10px 12px; border-radius: var(--box-radius); background: var(--hover); display: flex; flex-direction: column; gap: 6px; }
	.workerdetail .workerhead { display: flex; align-items: center; gap: 8px; }
	.workerdetail .title { font-weight: 500; overflow-wrap: anywhere; }
	.workerdetail .desc { color: var(--ink-secondary); font-size: var(--size-small); overflow-wrap: anywhere; }
	.workerdetail .answer { white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--size-small); background: var(--document); border-radius: var(--tile-radius); padding: 8px 10px; }
	.workerdetail .meta { display: flex; gap: 8px; flex-wrap: wrap; color: var(--ink-tertiary); font-size: var(--size-micro); }
	.workerdetail .activity { display: flex; flex-direction: column; gap: 2px; }
	.workerdetail .activity .k { font-size: var(--size-micro); color: var(--ink-tertiary); text-transform: uppercase; letter-spacing: 0.04em; }
	.act { font-size: var(--size-micro); font-family: var(--face-mono); color: var(--ink-secondary); padding: 2px 6px; border-radius: var(--tile-radius); background: var(--document); }
	.act.dim { color: var(--ink-tertiary); }
	.pane header .opening { color: var(--ink-tertiary); font-size: var(--size-small); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46ch; }
	/* The chat is the content: entries fill the pane and scroll inside it. */
	#content[data-view="thread"] { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }
	a.entry { text-decoration: none; color: inherit; cursor: pointer; }
	a.entry:hover { filter: brightness(1.06); }
	.collapse {
		margin-left: auto; text-decoration: none; color: var(--ink-tertiary);
		font-size: var(--size-label); padding: 2px 8px; border-radius: var(--chip-radius);
	}
	.collapse:hover { background: var(--hover); color: var(--ink); }
	.entries { display: flex; flex-direction: column; gap: 3px; padding: 0 14px 16px; overflow-y: auto; min-height: 0; }
	.entry { font-size: var(--size-small); padding: 6px 9px; border-radius: var(--tile-radius); background: var(--hover); white-space: pre-wrap; overflow-wrap: anywhere; }
	.entry.them { background: var(--active); }
	.entry.me { background: var(--hover); }
	.entry.said { background: transparent; color: var(--ink-secondary); font-size: var(--size-micro); padding: 2px 9px; }
	.entry.work { background: var(--working-soft); color: var(--working); }
	.entry.failed { background: var(--critical-soft); color: var(--critical); }
	.entry .who { display: block; font-size: var(--size-micro); color: var(--ink-tertiary); margin-bottom: 2px; }
	.entry.mono { font-family: var(--face-mono); font-size: var(--size-micro); }
	.mono { font-family: var(--face-mono); font-size: var(--size-micro); }
	.hidden { display: none !important; }

	/* Charts: shadcn's palette, in this theme's chart slots. */
	:root {
		--chart-1: oklch(0.646 0.222 41.116);
		--chart-2: oklch(0.6 0.118 184.704);
		--chart-3: oklch(0.398 0.07 227.392);
		--chart-4: oklch(0.828 0.189 84.429);
		--chart-5: oklch(0.769 0.188 70.08);
	}
	@media (prefers-color-scheme: dark) {
		:root {
			--chart-1: oklch(0.488 0.243 264.376);
			--chart-2: oklch(0.696 0.17 162.48);
			--chart-3: oklch(0.769 0.188 70.08);
			--chart-4: oklch(0.627 0.265 303.9);
			--chart-5: oklch(0.645 0.246 16.439);
		}
	}
	.charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--gap); align-items: start; }
	.chart { margin: 0; background: var(--hover); border-radius: var(--box-radius); padding: 12px 14px 6px; display: flex; flex-direction: column; gap: 6px; }
	.chart figcaption { display: flex; align-items: baseline; gap: 8px; }
	.chart .charttitle { font-weight: 500; font-size: var(--size-small); }
	.chart .chartnote { color: var(--ink-tertiary); font-size: var(--size-micro); }
	.chart svg { width: 100%; height: auto; max-height: 170px; display: block; overflow: visible; }
`;
