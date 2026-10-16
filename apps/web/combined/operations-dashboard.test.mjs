import test from 'node:test';
import assert from 'node:assert/strict';
import { groupPeriods, parseDashboard, periodKey, rulesText, zoneTotals } from './dashboard-model.ts';
import { checkRange, dashboardMarkup, mountDashboard, periodTable, vehicleTable, zoneTable } from './operations-dashboard.ts';

const vehicle = (over = {}) => ({ vehicleId: 'G1', plate: '12가 3456', label: '김기사', driver: 'kim', stops: 3, boxes: 4, orders: 4, stopsDone: 3, boxesDelivered: 4, ordersDone: 4, stopsSkipped: 0, departedAt: '2026-10-13T10:00:00+09:00', lastArrivedAt: '2026-10-13T10:25:00+09:00', finishedAt: '2026-10-13T10:30:00+09:00', driveMinutes: 30, distanceKm: 12.3, distanceBasis: 'estimate', actualKm: null, boxesPerStop: 1.3, minutesPerStop: 10, ...over });
const day = (date, over = {}) => ({ date, phase: 'published', orders: 4, boxes: 4, stops: 3, vehicles: [vehicle()], zones: [{ zoneId: 'Z1', orders: 4, boxes: 4, stops: 3 }], unlocatedOrders: 0, ...over });
const payload = (days, over = {}) => ({ from: days[0].date, to: days.at(-1).date, incentiveRules: null, days, ...over });

test('days are grouped by day, Monday week and month, and sums stay sums', () => {
  assert.equal(periodKey('2026-10-13', 'week'), '2026-10-12');
  assert.equal(periodKey('2026-10-18', 'week'), '2026-10-12');
  assert.equal(periodKey('2026-10-19', 'week'), '2026-10-19');
  assert.equal(periodKey('2026-10-13', 'month'), '2026-10');
  const dashboard = parseDashboard(payload([day('2026-10-12'), day('2026-10-13'), day('2026-10-20')]));
  const weeks = groupPeriods(dashboard.days, 'week');
  assert.deepEqual(weeks.map(period => [period.key, period.orders, period.boxes, period.stops, period.days]), [['2026-10-12', 8, 8, 6, 2], ['2026-10-19', 4, 4, 3, 1]]);
  assert.equal(weeks[0].boxesPerStop, 1.3);
  assert.equal(groupPeriods(dashboard.days, 'month').length, 1);
  assert.equal(groupPeriods(dashboard.days, 'day')[0].incentive, null, 'no rule means no fee, not 0 won');
});

test('the extra fee is summed over the days that had a rule and shown in the table only with a rule', () => {
  const rules = { unit: 'boxes', dailyTarget: 2, ratePerUnit: 500, targetsByDriver: { kim: 3 } };
  const dashboard = parseDashboard(payload([day('2026-10-12', { incentive: { people: 1, amount: 1000 } }), day('2026-10-13', { incentive: { people: 2, amount: 500 } })], { incentiveRules: rules }));
  assert.deepEqual(groupPeriods(dashboard.days, 'week')[0].incentive, { people: 3, amount: 1500 });
  assert.match(periodTable(dashboard, 'week'), /1,500원/);
  assert.match(rulesText(dashboard), /하루 2박스를 넘은 박스마다 500원\(기사 1명은 개인 목표\)/);
  assert.doesNotMatch(periodTable(parseDashboard(payload([day('2026-10-12')])), 'day'), /추가 수수료/);
  assert.match(rulesText(parseDashboard(payload([day('2026-10-12')]))), /규칙\(incentive-rules.json\)이 없어/);
  assert.match(rulesText(parseDashboard(payload([day('2026-10-12')], { incentiveRulesError: 'INCENTIVE_RULES_INVALID' }))), /읽을 수 없어/);
});

test('the vehicle table shows unknown figures as a dash, the distance as an estimate and a running vehicle as 진행 중', () => {
  const dashboard = parseDashboard(payload([day('2026-10-13', { vehicles: [vehicle(), vehicle({ vehicleId: 'G2', label: '이기사', finishedAt: null, driveMinutes: null, distanceKm: null, minutesPerStop: null })] })]));
  const html = vehicleTable(dashboard);
  assert.match(html, /추정 거리\(km\)/);
  assert.match(html, /10:00/);
  assert.match(html, /진행 중/);
  assert.match(html, /<td>—<\/td>/);
  assert.match(vehicleTable(parseDashboard(payload([day('2026-10-13', { vehicles: [] })]))), /확정된 배차가 없습니다/);
});

test('zones add up over days, use labels when known and say what is left out', () => {
  const dashboard = parseDashboard(payload([day('2026-10-12'), day('2026-10-13', { zones: [{ zoneId: 'Z1', orders: 1, boxes: 1, stops: 1 }, { zoneId: 'Z2', orders: 2, boxes: 9, stops: 1 }], unlocatedOrders: 2 })]));
  assert.deepEqual(zoneTotals(dashboard.days).map(zone => [zone.zoneId, zone.boxes]), [['Z2', 9], ['Z1', 5]]);
  const html = zoneTable(dashboard.days, new Map([['Z2', '강남']]));
  assert.match(html, /강남/);
  assert.match(html, /권역을 알 수 없는 주문 2건/);
});

test('the range is checked before a request is made', () => {
  assert.match(checkRange('', '2026-10-13'), /날짜/);
  assert.match(checkRange('2026-10-14', '2026-10-13'), /종료일/);
  assert.match(checkRange('2026-09-01', '2026-10-02'), /31일/);
  assert.equal(checkRange('2026-09-30', '2026-10-30'), '');
  assert.equal(checkRange('2026-02-30', '2026-03-01') !== '', true);
});

function fixture(fetchImpl) {
  const nodes = new Map();
  const make = () => ({ innerHTML: '', textContent: '', value: '', listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } });
  const element = { querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, make()); return nodes.get(selector); } };
  const dashboard = mountDashboard({ element, fetchImpl, today: () => '2026-10-13' });
  return { dashboard, node: selector => nodes.get(selector) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('the first visit loads the last seven days once, and a grain change redraws without a request', async () => {
  const urls = [];
  const { dashboard, node } = fixture(async url => { urls.push(url); return { ok: true, status: 200, json: async () => (url.includes('regions') ? { features: [{ properties: { zoneId: 'Z1', label: '강남' } }] } : payload([day('2026-10-13')])) }; });
  assert.match(dashboardMarkup(), /data-dash-form/);
  dashboard.show(); dashboard.show();
  await flush(); await flush();
  assert.equal(urls.filter(url => url.includes('/api/ops/dashboard')).length, 1);
  assert.match(urls[0], /from=2026-10-07&to=2026-10-13/);
  assert.match(node('[data-dash-body]').innerHTML, /data-dash-periods/);
  assert.match(node('[data-dash-body]').innerHTML, /강남/);
  node('[data-ops-dashboard]').listeners.change({ target: { dataset: { dashGrain: '' }, value: 'month' } });
  assert.match(node('[data-dash-body]').innerHTML, /2026-10/);
  assert.equal(urls.filter(url => url.includes('/api/ops/dashboard')).length, 1);
});

test('a failure is worded and shows no stale figures', async () => {
  const { dashboard, node } = fixture(async () => ({ ok: false, status: 403, json: async () => ({}) }));
  dashboard.show();
  await flush();
  assert.match(node('[data-dash-message]').textContent, /운영자 계정만/);
  assert.equal(node('[data-dash-body]').innerHTML, '');
});
