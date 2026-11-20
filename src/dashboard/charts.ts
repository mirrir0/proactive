/**
 * The metrics page's charts as SVG on the server: shadcn's chart language (palette, dashed
 * grid, radii) without a client framework. Every chart is a pure function of numbers.
 */

/** The palette, in the order shadcn's `--chart-1..5` uses. */
export const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"] as const;

/** The six forms, as things a page can link to. */
export type ChartId = "work" | "turns" | "counters" | "parts" | "shape" | "full";

export interface ChartCopy {
	id: ChartId;
	title: string;
	/** What it is, in one line, for the card. */
	note: string;
	/** What it measures, in a sentence. */
	what: string;
	/** How to read it, and what "wrong" looks like. */
	how: string[];
}

/** The six charts, with the words that explain them in the modal. */
export const CHART_COPY: Record<ChartId, ChartCopy> = {
	work: {
		id: "work",
		title: "Work over time",
		note: "in flight, and conversations seen — sampled while this page is open",
		what: "Two lines sampled every couple of seconds: how many tasks are in flight, and how many conversations exist.",
		how: [
			"A flat line at zero means the brain is idle — nothing is running and nothing is queued.",
			"A line that steps up and stays up means work is accumulating: tasks are dispatched faster than they finish.",
			"The dashed line is conversations, not work: it only ever grows, so a step in it is a new chat, not a new problem.",
		],
	},
	turns: {
		id: "turns",
		title: "Router turns",
		note: "cumulative, since this brain started",
		what: "Every turn the Router has taken — one message, or a batch of them, answered by the model.",
		how: [
			"A steep slope means many turns: each one costs a model call, so this is the shape of the bill.",
			"A flat stretch means nothing has arrived, or the brain is stuck mid-turn — the state block says which.",
			"Turns are cheap when they dispatch and expensive when they think; compare with the dispatch counter.",
		],
	},
	counters: {
		id: "counters",
		title: "What happens most",
		note: "the counters with the largest totals",
		what: "The eight biggest counters in the registry, by total since start.",
		how: [
			"These are events, not rates: a big total is something that happened a lot, not something happening now.",
			"A counter with an unexpected name is the first clue in a bug hunt — `mir_*_total` names are the vocabulary.",
			"If pushes dominate, the dashboard itself is the busiest thing in the brain.",
		],
	},
	parts: {
		id: "parts",
		title: "By part of the brain",
		note: "router, worker, hands, mcp, dashboard",
		what: "Counters grouped by their prefix: which part of the brain is doing the most.",
		how: [
			"A dominant slice says where the work is: router turns, worker tasks, hand calls, MCP calls, or the dashboard.",
			"Hands dominating with little work means a Worker is retrying a failing call.",
			"A thin slice is not a problem; a slice that disappears is a part that stopped being used.",
		],
	},
	shape: {
		id: "shape",
		title: "Shape of the work",
		note: "the same groups, relative to each other",
		what: "The same five groups as a radar: the shape of the system's activity.",
		how: [
			"A balanced shape is a healthy system: router, workers and hands all in play.",
			"A spike in one axis with the others flat means everything is going through one part.",
			"The polygon is normalised to the biggest group, so read the shape, not the size.",
		],
	},
	full: {
		id: "full",
		title: "How full",
		note: "work, hands, threads and hand load, as a share",
		what: "Four gauges as rings: in-flight work, connected hands, busy threads, and hand load.",
		how: [
			"A ring at 100% is at capacity — the next dispatch queues rather than runs.",
			"Hands at 100% with work at 100% means the queue is the hands, not the model.",
			"A ring that never moves is a gauge that is not wired; that is worth knowing too.",
		],
	},
};

export interface Point {
	label: string;
	value: number;
}

export interface Series {
	label: string;
	values: number[];
	/** Index into `CHART_COLORS`. */
	color?: number;
	dashed?: boolean;
}

const W = 640;
const H = 180;
const PAD = { top: 12, right: 12, bottom: 18, left: 12 };

	/** No `preserveAspectRatio="none"`: stretching squashes glyphs and turns a donut into an oval. */
function frame(inner: string, title: string, note: string, box: { w: number; h: number } = { w: W, h: H }): string {
	return `<figure class="chart">
		<figcaption><span class="charttitle">${escape(title)}</span><span class="chartnote">${escape(note)}</span></figcaption>
		<svg viewBox="0 0 ${box.w} ${box.h}" role="img" aria-label="${escape(title)}">${inner}</svg>
	</figure>`;
}

function grid(): string {
	const lines: string[] = [];
	for (let i = 0; i <= 4; i += 1) {
		const y = PAD.top + ((H - PAD.top - PAD.bottom) * i) / 4;
		lines.push(`<line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}" stroke="var(--rule)" stroke-dasharray="3 6" stroke-width="1"/>`);
	}
	return lines.join("");
}

function scaled(series: Series[]): (value: number) => number {
	const all = series.flatMap((entry) => entry.values);
	const max = Math.max(1, ...all);
	const height = H - PAD.top - PAD.bottom;
	return (value: number) => PAD.top + height - (value / max) * height;
}

function points(values: number[], y: (value: number) => number): string {
	const width = W - PAD.left - PAD.right;
	const step = values.length <= 1 ? 0 : width / (values.length - 1);
	return values.map((value, index) => `${(PAD.left + step * index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
}

/** A line per series, no dots, one optional dashed comparison. */
export function lineChart(series: Series[], title: string, note: string): string {
	const y = scaled(series);
	const lines = series
		.map(
			(entry, index) =>
				`<polyline fill="none" stroke="${CHART_COLORS[entry.color ?? index]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${
					entry.dashed === true ? ' stroke-dasharray="4 6"' : ""
				} points="${points(entry.values, y)}"/>`,
		)
		.join("");
	return frame(grid() + lines + legend(series), title, note);
}

/** The same data as a filled area: a soft gradient under a 2px line. */
export function areaChart(series: Series[], title: string, note: string): string {
	const y = scaled(series);
	const first = series[0];
	if (first === undefined) return frame(grid(), title, note);
	const width = W - PAD.left - PAD.right;
	const step = first.values.length <= 1 ? 0 : width / (first.values.length - 1);
	const line = points(first.values, y);
	const area = `${PAD.left},${H - PAD.bottom} ${line} ${(PAD.left + step * (first.values.length - 1)).toFixed(1)},${H - PAD.bottom}`;
	return frame(
		`${grid()}<defs><linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stop-color="${CHART_COLORS[0]}" stop-opacity="0.35"/>
			<stop offset="100%" stop-color="${CHART_COLORS[0]}" stop-opacity="0.02"/>
		</linearGradient></defs>
		<polygon points="${area}" fill="url(#area-fill)"/>
		<polyline fill="none" stroke="${CHART_COLORS[0]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${line}"/>
		${legend(series)}`,
		title,
		note,
	);
}

/** Horizontal bars, 4px radius at the end that grows. */
export function barChart(items: Point[], title: string, note: string): string {
	if (items.length === 0) return frame(grid(), title, note);
	const max = Math.max(1, ...items.map((item) => item.value));
	const rowHeight = (H - PAD.top - PAD.bottom) / items.length;
	const width = W - PAD.left - PAD.right - 96;
	const bars = items
		.map((item, index) => {
			const barWidth = Math.max(2, (item.value / max) * width);
			const y = PAD.top + rowHeight * index + rowHeight * 0.18;
			const height = rowHeight * 0.64;
			return `<rect x="${PAD.left}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}" rx="4" fill="${CHART_COLORS[index % CHART_COLORS.length]}"/>
				<text x="${PAD.left + width + 8}" y="${(y + height * 0.78).toFixed(1)}" fill="var(--ink-tertiary)" font-size="9">${escape(item.label)} · ${format(item.value)}</text>`;
		})
		.join("");
	return frame(bars, title, note);
}

/** A donut, one arc per slice, with the total in the middle. */
export function pieChart(items: Point[], title: string, note: string): string {
	const total = items.reduce((sum, item) => sum + item.value, 0);
	if (total === 0) return frame(grid(), title, note);
	const BOX = { w: 360, h: 200 };
	const cx = BOX.w / 2;
	const cy = BOX.h / 2;
	const outer = Math.min(BOX.h, BOX.w) / 2 - 16;
	const inner = outer * 0.58;
	let angle = -Math.PI / 2;
	const arcs = items
		.map((item, index) => {
			const sweep = (item.value / total) * Math.PI * 2;
			const colour = CHART_COLORS[index % CHART_COLORS.length];
			// One slice is a ring, and a path that starts and ends at the same point
			// draws nothing: it is two half-arcs, or a stroked circle.
			const path =
				sweep >= Math.PI * 2 - 1e-6
					? `<circle cx="${cx}" cy="${cy}" r="${(inner + outer) / 2}" fill="none" stroke="${colour}" stroke-width="${outer - inner}"/>`
					: `<path d="${sector(cx, cy, inner, outer, angle, angle + sweep)}" fill="${colour}"/>`;
			angle += sweep;
			return path;
		})
		.join("");
	return frame(
		`${arcs}<text x="${cx}" y="${cy + 3}" text-anchor="middle" fill="var(--ink)" font-size="13" font-weight="600">${format(total)}</text>
		<text x="${cx}" y="${cy + 16}" text-anchor="middle" fill="var(--ink-tertiary)" font-size="8">total</text>`,
		title,
		note,
		BOX,
	);
}

/** A radar: the grid polygon, then the data polygon over it. */
export function radarChart(items: Point[], title: string, note: string): string {
	if (items.length < 3) {
		// Two points make a line, not a radar: say so rather than draw a grid.
		return frame(
			`<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="var(--ink-tertiary)" font-size="10">not enough groups yet</text>`,
			title,
			note,
		);
	}
	const BOX = { w: 360, h: 200 };
	const cx = BOX.w / 2;
	const cy = BOX.h / 2 + 4;
	const radius = Math.min(BOX.h, BOX.w) / 2 - 30;
	const max = Math.max(1, ...items.map((item) => item.value));
	const at = (index: number, ratio: number): [number, number] => {
		const angle = -Math.PI / 2 + (index / items.length) * Math.PI * 2;
		return [cx + Math.cos(angle) * radius * ratio, cy + Math.sin(angle) * radius * ratio];
	};
	const rings = [0.25, 0.5, 0.75, 1]
		.map((ratio) => {
			const polygon = items.map((_, index) => at(index, ratio).map((n) => n.toFixed(1)).join(",")).join(" ");
			return `<polygon points="${polygon}" fill="none" stroke="var(--rule)" stroke-dasharray="3 6"/>`;
		})
		.join("");
	const spokes = items
		.map((_, index) => {
			const [x, y] = at(index, 1);
			return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--rule)" stroke-dasharray="3 6"/>`;
		})
		.join("");
	const shape = items.map((item, index) => at(index, item.value / max).map((n) => n.toFixed(1)).join(",")).join(" ");
	const labels = items
		.map((item, index) => {
			const [x, y] = at(index, 1.16);
			return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" fill="var(--ink-tertiary)" font-size="8">${escape(item.label)}</text>`;
		})
		.join("");
	return frame(
		`${rings}${spokes}<polygon points="${shape}" fill="${CHART_COLORS[0]}" fill-opacity="0.22" stroke="${CHART_COLORS[0]}" stroke-width="2"/>${labels}`,
		title,
		note,
		BOX,
	);
}

/** Concentric rings, one per gauge: how full each thing is. */
export function radialChart(items: Point[], title: string, note: string): string {
	const BOX = { w: 360, h: 200 };
	const cx = BOX.w / 2;
	const cy = BOX.h / 2;
	const rings = items.slice(0, 4);
	const gap = 12;
	const widest = Math.min(BOX.h, BOX.w) / 2 - 22;
	const arcs = rings
		.map((item, index) => {
			const radius = widest - index * gap;
			const ratio = Math.max(0, Math.min(1, item.value));
			const start = -Math.PI / 2;
			const track = sector(cx, cy, radius - 5, radius, start, start + Math.PI * 2);
			const filled = sector(cx, cy, radius - 5, radius, start, start + Math.PI * 2 * ratio);
			return `<path d="${track}" fill="var(--rule)"/><path d="${filled}" fill="${CHART_COLORS[index % CHART_COLORS.length]}"/>`;
		})
		.join("");
	const labels = rings
		.map((item, index) => {
			const y = cy - 18 + index * 13;
			return `<circle cx="${cx + widest + 10}" cy="${y - 3}" r="3" fill="${CHART_COLORS[index % CHART_COLORS.length]}"/>
				<text x="${cx + widest + 18}" y="${y}" fill="var(--ink-tertiary)" font-size="9">${escape(item.label)} ${Math.round(item.value * 100)}%</text>`;
		})
		.join("");
	return frame(arcs + labels, title, note, BOX);
}

function legend(series: Series[]): string {
	if (series.length < 2) return "";
	return series
		.map(
			(entry, index) =>
				`<circle cx="${PAD.left + index * 96 + 4}" cy="${H - 6}" r="3" fill="${CHART_COLORS[entry.color ?? index]}"/><text x="${PAD.left + index * 96 + 12}" y="${H - 3}" fill="var(--ink-tertiary)" font-size="8">${escape(entry.label)}</text>`,
		)
		.join("");
}

/** An annular sector, as a path. */
function sector(cx: number, cy: number, inner: number, outer: number, from: number, to: number): string {
	const large = to - from > Math.PI ? 1 : 0;
	const point = (radius: number, angle: number): string => `${(cx + Math.cos(angle) * radius).toFixed(2)} ${(cy + Math.sin(angle) * radius).toFixed(2)}`;
	return [
		`M ${point(outer, from)}`,
		`A ${outer} ${outer} 0 ${large} 1 ${point(outer, to)}`,
		`L ${point(inner, to)}`,
		`A ${inner} ${inner} 0 ${large} 0 ${point(inner, from)}`,
		"Z",
	].join(" ");
}

function format(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(Math.round(value * 10) / 10);
}

function escape(text: string): string {
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
