import { clockText, formatCelsius } from './temperature-model.ts';
import type { Measurement } from './temperature-client.ts';

// The line graph of one vehicle's day, as plain SVG. Pure: it turns readings into coordinates and text. A stretch with
// no reading is left empty (the line breaks), because a missing reading is not a value to interpolate.

export const GAP_MS = 5 * 60_000;
export const MAX_POINTS = 1500;
export type Range = { min: number | null; max: number | null };
export type Point = { x: number; y: number; t: number; celsius: number; sensorId: string };
export type SensorLine = { sensorId: string; index: number; path: string; band: string; dots: Point[]; count: number };
export type Stats = { min: number; max: number; average: number; last: number; lastAt: string; count: number };
export type Graph = {
  width: number; height: number; plot: { left: number; top: number; right: number; bottom: number };
  xTicks: { x: number; label: string }[]; yTicks: { y: number; label: string }[];
  rangeLines: { y: number; label: string }[]; lines: SensorLine[]; points: Point[]; stats: Stats | null; decimated: boolean;
};

const round = (value: number): number => Math.round(value * 10) / 10;
const X_STEPS_MIN = [10, 30, 60, 120, 180, 360];
const Y_STEPS = [0.5, 1, 2, 5, 10, 20];

function niceDomain(low: number, high: number): { low: number; high: number; step: number } {
  const span = Math.max(high - low, 1);
  const padded = { low: low - span * 0.1, high: high + span * 0.1 };
  const step = Y_STEPS.find(candidate => (padded.high - padded.low) / candidate <= 6) ?? 20;
  return { low: Math.floor(padded.low / step) * step, high: Math.ceil(padded.high / step) * step, step };
}

/** Keeps the first and last reading and an even stride between, so that a long raw day stays drawable. */
export function decimate<T>(items: T[], limit: number = MAX_POINTS): T[] {
  if (items.length <= limit) return items;
  const stride = (items.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, index) => items[Math.round(index * stride)]!);
}

export function buildGraph(input: { measurements: Measurement[]; from: string; to: string; ranges: Range[]; width?: number; height?: number }): Graph {
  const width = input.width ?? 640;
  const height = input.height ?? 260;
  const plot = { left: 48, top: 12, right: width - 12, bottom: height - 28 };
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  const inside = input.measurements.filter(item => {
    const time = Date.parse(item.measuredAt);
    return time >= fromMs && time <= toMs;
  });
  const bounds = input.ranges.flatMap(range => [range.min, range.max]).filter((value): value is number => value !== null);
  const values = inside.flatMap(item => [item.min ?? item.celsius, item.max ?? item.celsius, item.celsius]);
  const known = [...values, ...bounds];
  const domain = niceDomain(known.length ? Math.min(...known) : -1, known.length ? Math.max(...known) : 1);
  const x = (time: number): number => round(plot.left + ((time - fromMs) / Math.max(toMs - fromMs, 1)) * (plot.right - plot.left));
  const y = (value: number): number => round(plot.bottom - ((value - domain.low) / (domain.high - domain.low)) * (plot.bottom - plot.top));

  const yTicks: Graph['yTicks'] = [];
  for (let value = domain.low; value <= domain.high + 1e-9; value += domain.step) yTicks.push({ y: y(value), label: formatCelsius(round(value)) });
  const stepMs = (X_STEPS_MIN.find(step => (toMs - fromMs) / (step * 60_000) <= 8) ?? 360) * 60_000;
  const xTicks: Graph['xTicks'] = [];
  for (let time = fromMs; time <= toMs + 1; time += stepMs) xTicks.push({ x: x(time), label: clockText(new Date(time).toISOString()) });

  const sensors = [...new Set(inside.map(item => item.sensorId))].sort();
  let decimated = false;
  const lines = sensors.map((sensorId, index): SensorLine => {
    const own = inside.filter(item => item.sensorId === sensorId).sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt));
    const kept = decimate(own);
    decimated ||= kept.length < own.length;
    const segments: Measurement[][] = [];
    for (const item of kept) {
      const last = segments.at(-1);
      if (last && Date.parse(item.measuredAt) - Date.parse(last.at(-1)!.measuredAt) <= GAP_MS) last.push(item);
      else segments.push([item]);
    }
    const point = (item: Measurement): Point => ({ x: x(Date.parse(item.measuredAt)), y: y(item.celsius), t: Date.parse(item.measuredAt), celsius: item.celsius, sensorId });
    const path = segments.flatMap(segment => (segment.length > 1
      ? [segment.map((item, at) => `${at ? 'L' : 'M'}${point(item).x} ${point(item).y}`).join(' ')] : [])).join(' ');
    const spread = (segment: Measurement[]) => segment.some(item => item.min !== null && item.max !== null && item.max > item.min);
    const band = segments.flatMap(segment => {
      if (segment.length < 2 || !spread(segment)) return [];
      const top = segment.map(item => `${x(Date.parse(item.measuredAt))} ${y(item.max ?? item.celsius)}`);
      const bottom = [...segment].reverse().map(item => `${x(Date.parse(item.measuredAt))} ${y(item.min ?? item.celsius)}`);
      return [`M${top.join(' L')} L${bottom.join(' L')} Z`];
    }).join(' ');
    const dots = segments.flatMap(segment => (segment.length === 1 ? [point(segment[0]!)] : []));
    return { sensorId, index, path, band, dots, count: own.length };
  });
  const points = decimate(inside.map((item): Point => ({ x: x(Date.parse(item.measuredAt)), y: y(item.celsius), t: Date.parse(item.measuredAt), celsius: item.celsius, sensorId: item.sensorId }))
    .sort((a, b) => a.t - b.t));

  const seen = new Set<number>();
  const rangeLines: Graph['rangeLines'] = [];
  for (const range of input.ranges) {
    for (const [value, kind] of [[range.min, '하한'], [range.max, '상한']] as const) {
      if (value === null || seen.has(value)) continue;
      seen.add(value);
      rangeLines.push({ y: y(value), label: `${kind} ${formatCelsius(value)}` });
    }
  }

  let stats: Stats | null = null;
  if (inside.length) {
    const weight = (item: Measurement) => item.count ?? 1;
    const total = inside.reduce((sum, item) => sum + weight(item), 0);
    const newest = inside.reduce((best, item) => (Date.parse(item.measuredAt) >= Date.parse(best.measuredAt) ? item : best));
    stats = {
      min: Math.min(...inside.map(item => item.min ?? item.celsius)), max: Math.max(...inside.map(item => item.max ?? item.celsius)),
      average: inside.reduce((sum, item) => sum + item.celsius * weight(item), 0) / total, last: newest.celsius, lastAt: newest.measuredAt, count: total,
    };
  }
  return { width, height, plot, xTicks, yTicks, rangeLines, lines, points, stats, decimated };
}

/** The reading nearest to a horizontal position of the graph, for a pointer or key. */
export function nearestPoint(graph: Graph, x: number): Point | null {
  let best: Point | null = null;
  for (const point of graph.points) if (!best || Math.abs(point.x - x) < Math.abs(best.x - x)) best = point;
  return best;
}

export function statsText(stats: Stats | null): string {
  return stats ? `최저 ${formatCelsius(stats.min)}, 최고 ${formatCelsius(stats.max)}, 평균 ${formatCelsius(round(stats.average))}, 마지막 ${formatCelsius(stats.last)} (${clockText(stats.lastAt)})` : '수신된 온도가 없습니다';
}

const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function graphSvg(graph: Graph, title: string): string {
  const { plot } = graph;
  const grid = graph.yTicks.map(tick => `<line class="temperature-grid" x1="${plot.left}" x2="${plot.right}" y1="${tick.y}" y2="${tick.y}"/><text class="temperature-axis" x="${plot.left - 6}" y="${tick.y + 4}" text-anchor="end">${esc(tick.label)}</text>`).join('');
  const hours = graph.xTicks.map(tick => `<text class="temperature-axis" x="${tick.x}" y="${plot.bottom + 18}" text-anchor="middle">${esc(tick.label)}</text>`).join('');
  const limits = graph.rangeLines.map(line => `<line class="temperature-limit" x1="${plot.left}" x2="${plot.right}" y1="${line.y}" y2="${line.y}"/><text class="temperature-limit-label" x="${plot.right}" y="${line.y - 4}" text-anchor="end">${esc(line.label)}</text>`).join('');
  const series = graph.lines.map(line => `${line.band ? `<path class="temperature-band temperature-series-${line.index % 4}" d="${line.band}"/>` : ''}${line.path ? `<path class="temperature-line temperature-series-${line.index % 4}" d="${line.path}"/>` : ''}${line.dots.map(dot => `<circle class="temperature-dot temperature-series-${line.index % 4}" cx="${dot.x}" cy="${dot.y}" r="2.5"/>`).join('')}`).join('');
  return `<svg class="temperature-svg" viewBox="0 0 ${graph.width} ${graph.height}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>${grid}${limits}${series}${hours}<line class="temperature-cursor" data-temp-cursor x1="0" x2="0" y1="${plot.top}" y2="${plot.bottom}" hidden/></svg>`;
}
