import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, decimate, GAP_MS, graphSvg, MAX_POINTS, nearestPoint, statsText } from './temperature-graph.ts';

const FROM = '2026-11-02T00:00:00+09:00';
const TO = '2026-11-03T00:00:00+09:00';
const at = (minute, sensorId = 'S1', celsius = -18, extra = {}) => ({
  sensorId, measuredAt: new Date(Date.parse(FROM) + minute * 60_000).toISOString(), celsius, min: celsius - 0.2, max: celsius + 0.2, count: 6, ...extra,
});
const graph = (measurements, ranges = []) => buildGraph({ measurements, from: FROM, to: TO, ranges });

test('a day of readings becomes one line whose points lie inside the plot, earlier to the left', () => {
  const result = graph([at(0, 'S1', -18.4), at(1, 'S1', -18.1), at(2, 'S1', -17.9)]);
  assert.equal(result.lines.length, 1);
  const [first, second, third] = result.points;
  assert.ok(first.x < second.x && second.x < third.x);
  for (const point of result.points) assert.ok(point.x >= result.plot.left && point.x <= result.plot.right && point.y >= result.plot.top && point.y <= result.plot.bottom);
  assert.ok(first.y > third.y, '더 높은 온도는 위에 그린다');
  assert.match(result.lines[0].path, /^M\d/);
});

test('a stretch without readings breaks the line instead of joining the two sides', () => {
  const gap = GAP_MS / 60_000;
  const result = graph([at(0), at(1), at(2), at(2 + gap + 1), at(3 + gap + 1)]);
  assert.equal([...result.lines[0].path.matchAll(/M/g)].length, 2, '두 구간');
  const joined = graph([at(0), at(1), at(1 + gap)]);
  assert.equal([...joined.lines[0].path.matchAll(/M/g)].length, 1, '5분 이내 간격은 이어진다');
  const lone = graph([at(0), at(100)]);
  assert.equal(lone.lines[0].path, '');
  assert.equal(lone.lines[0].dots.length, 2, '혼자 있는 값은 점으로 남는다');
});

test('each sensor has its own line and the readings outside the window are ignored', () => {
  const result = graph([at(0, 'S2'), at(1, 'S2'), at(0, 'S1'), at(1, 'S1'), at(-30, 'S1'), at(1500, 'S1')]);
  assert.deepEqual(result.lines.map(line => [line.sensorId, line.count]), [['S1', 2], ['S2', 2]]);
  assert.deepEqual(result.lines.map(line => line.index), [0, 1]);
});

test('the axis covers the values and the allowed range, with whole-number ticks and hourly time labels', () => {
  const result = graph([at(0, 'S1', -18.4), at(10, 'S1', -17.6)], [{ min: null, max: -18 }, { min: 0, max: 5 }]);
  const labels = result.yTicks.map(tick => tick.label);
  assert.ok(labels.includes('0.0°C') && labels.some(label => label.startsWith('-2')), labels.join());
  assert.deepEqual(result.rangeLines.map(line => line.label), ['상한 -18.0°C', '하한 0.0°C', '상한 5.0°C']);
  assert.equal(result.xTicks[0].label, '00:00');
  assert.ok(result.xTicks.length >= 5 && result.xTicks.length <= 13);
  const topY = Math.min(...result.yTicks.map(tick => tick.y));
  assert.ok(result.rangeLines.every(line => line.y >= topY));
});

test('the numbers beside the graph are the lowest, highest, average, last and count of what was received', () => {
  const result = graph([at(0, 'S1', -19, { min: -19.5, max: -18.5, count: 2 }), at(5, 'S1', -17, { min: -17.2, max: -16.8, count: 6 })]);
  assert.equal(result.stats.min, -19.5);
  assert.equal(result.stats.max, -16.8);
  assert.equal(result.stats.last, -17);
  assert.equal(result.stats.count, 8);
  assert.ok(Math.abs(result.stats.average - (-19 * 2 + -17 * 6) / 8) < 1e-9, '평균은 건수로 가중한다');
  assert.match(statsText(result.stats), /^최저 -19\.5°C, 최고 -16\.8°C, 평균 -17\.5°C, 마지막 -17\.0°C \(00:05\)$/);
  assert.equal(statsText(null), '수신된 온도가 없습니다');
});

test('a day without readings still has an axis and no statistics', () => {
  const result = graph([]);
  assert.equal(result.stats, null);
  assert.equal(result.lines.length, 0);
  assert.ok(result.yTicks.length >= 2);
  assert.match(graphSvg(result, '빈 날'), /<svg/);
});

test('a very long raw day is drawn with a bounded number of points, first and last kept', () => {
  const items = Array.from({ length: MAX_POINTS * 3 }, (_, index) => index);
  const kept = decimate(items);
  assert.equal(kept.length, MAX_POINTS);
  assert.equal(kept[0], 0);
  assert.equal(kept.at(-1), items.at(-1));
  assert.equal(decimate([1, 2, 3]).length, 3);
  const dense = graph(Array.from({ length: 3000 }, (_, index) => at(index % 1400, 'S1', -18, { measuredAt: new Date(Date.parse(FROM) + index * 20_000).toISOString() })));
  assert.equal(dense.decimated, true);
  assert.ok(dense.points.length <= MAX_POINTS);
});

test('the reading nearest to a position is found, for the pointer and for the keys', () => {
  const result = graph([at(0), at(600, 'S1', -17), at(1200, 'S1', -16)]);
  const middle = result.points[1];
  assert.equal(nearestPoint(result, middle.x + 3), middle);
  assert.equal(nearestPoint(result, 0), result.points[0]);
  assert.equal(nearestPoint(graph([]), 100), null);
});

test('the SVG names its content for a reader that cannot see it and escapes what it was given', () => {
  const svg = graphSvg(graph([at(0), at(1)], [{ min: null, max: -18 }]), '김<기사> 2026-11-02 온도: 최저 -18.2°C');
  assert.match(svg, /role="img" aria-label="김&lt;기사&gt; 2026-11-02 온도: 최저 -18\.2°C"/);
  assert.match(svg, /<title>/);
  assert.match(svg, /상한 -18\.0°C/);
  assert.match(svg, /class="temperature-band temperature-series-0"/);
  assert.doesNotMatch(svg, /<기사>/);
});
