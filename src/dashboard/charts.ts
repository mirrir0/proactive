/**
 * charts.ts — the metrics page's six charts, as SVG, rendered on the server.
 *
 * shadcn's charts are Recharts wrappers: a React tree, a bundler, a client-side
 * runtime. The dashboard is one server-rendered document with real links, so what
 * is borrowed here is the *language* the components encode — the `--chart-1..5`
 * palette, a grid that is horizontal-only and dashed `3 6`, bars with a 4px radius,
 * a 2px line with no dots, an area with a soft gradient under it, ticks with no
 * line and no axis rule. Same six forms, same reading, no client framework.
 *
 * Every chart is a pure function of numbers: no state, no clock, no fetch. That is
 * what makes them testable, and what makes a page a document rather than an app.
 */

/** The palette, in the order shadcn's `--chart-1..5` uses. */
export const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"] as const;

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

/**
 * The figure around a chart.
 *
 * No `preserveAspectRatio="none"`: stretching a chart to its container squashes
 * every glyph, circle and bar — text becomes unreadable and a donut becomes an
 * oval. The viewBox scales uniformly instead, and the CSS lets the height follow.
 */
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
