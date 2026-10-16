import test from 'node:test';
import assert from 'node:assert/strict';
import { agoText, formatCelsius, kindOf, overviewRows, parseLatest, rangeText, readTemperature, sortByTemperature, temperatureView } from './temperature-model.ts';

const reading = (extra = {}) => ({ celsius: -18.4, measuredAt: '2026-11-02T09:12:30+09:00', stale: false, outOfRange: false, ...extra });
const latest = (vehicleId, extra = {}) => ({
  vehicleId, sensorId: 'S1', celsius: -18.1, measuredAt: '2026-11-02T09:12:30+09:00', receivedAt: '2026-11-02T09:12:31+09:00',
  ageSeconds: 29, stale: false, outOfRange: false, range: { min: null, max: -18 }, ...extra,
});

test('a vehicle with no value is "정보 없음", never a number', () => {
  assert.equal(readTemperature(undefined), null);
  assert.equal(readTemperature({ celsius: 'x', measuredAt: 'y' }), null);
  assert.equal(readTemperature({ celsius: NaN, measuredAt: 'y' }), null);
  assert.deepEqual(temperatureView(null), { kind: 'none', label: '정보 없음', tone: 'neutral', valueText: '정보 없음', text: '정보 없음' });
});

test('out of range wins over silent, silent over normal, and the state is named in words', () => {
  assert.equal(kindOf(reading({ outOfRange: true, stale: true })), 'out');
  assert.equal(kindOf(reading({ stale: true })), 'stale');
  assert.equal(kindOf(reading()), 'normal');
  const out = temperatureView(reading({ celsius: -12, outOfRange: true }));
  assert.deepEqual([out.label, out.tone, out.text], ['범위 밖', 'red', '-12.0°C 범위 밖']);
  const stale = temperatureView(reading({ stale: true }));
  assert.equal(stale.text, '-18.4°C 미수신, 마지막 수신 09:12');
  assert.equal(temperatureView(reading()).tone, 'green');
});

test('values are written with one decimal and a minus zero does not appear', () => {
  assert.equal(formatCelsius(-18.44), '-18.4°C');
  assert.equal(formatCelsius(-0.04), '0.0°C');
  assert.equal(formatCelsius(4), '4.0°C');
});

test('the age of a value reads in minutes, hours and days', () => {
  assert.deepEqual([0, 59, 60, 3599, 3600, 7200, 172_800, -1, NaN].map(agoText),
    ['방금', '방금', '1분 전', '59분 전', '1시간 전', '2시간 전', '2일 전', '미확인', '미확인']);
});

test('vehicles sort out of range, then silent, then normal, then without data, keeping the given order inside a group', () => {
  const rows = ['A', 'B', 'C', 'D', 'E', 'F'].map(id => ({ vehicle: { id } }));
  const states = {
    A: { temperature: reading() }, B: {}, C: { temperature: reading({ outOfRange: true }) },
    D: { temperature: reading({ stale: true }) }, E: { temperature: reading({ outOfRange: true }) }, F: { temperature: reading() },
  };
  assert.deepEqual(sortByTemperature(rows, states).map(row => row.vehicle.id), ['C', 'E', 'D', 'A', 'F', 'B']);
  assert.deepEqual(sortByTemperature(rows, undefined).map(row => row.vehicle.id), ['A', 'B', 'C', 'D', 'E', 'F']);
});

test('the latest list is validated and a malformed answer is refused as a whole', () => {
  const rows = parseLatest({ generatedAt: 'x', vehicles: [{ ...latest('V1'), compartment: 'frozen' }, latest('V2', { range: null })] });
  assert.equal(rows[0].compartment, 'frozen');
  assert.equal(rows[1].range, null);
  assert.throws(() => parseLatest({}), /온도 응답/);
  assert.throws(() => parseLatest({ vehicles: [{ ...latest('V1'), celsius: '1' }] }), /온도 응답/);
  assert.throws(() => parseLatest({ vehicles: [{ ...latest('V1'), stale: undefined }] }), /온도 응답/);
});

test('ranges are written in words, with either bound missing', () => {
  assert.equal(rangeText(null), '범위 없음');
  assert.equal(rangeText({ min: null, max: null }), '범위 없음');
  assert.equal(rangeText({ min: null, max: -18 }), '-18.0°C 이하');
  assert.equal(rangeText({ min: 0, max: null }), '0.0°C 이상');
  assert.equal(rangeText({ min: 0, max: 5 }), '0.0°C ~ 5.0°C');
});

test('the overview has one row per vehicle: the fleet plus senders, the worst sensor standing for a vehicle', () => {
  const fleet = [{ id: 'V1', driver: '김' }, { id: 'V2', driver: '이' }, { id: 'V3', driver: '박' }];
  const rows = overviewRows(fleet, [
    latest('V1', { celsius: -18.5 }), latest('V1', { sensorId: 'S2', celsius: -9, outOfRange: true }),
    latest('V3', { stale: true, ageSeconds: 900 }), latest('GHOST'),
  ]);
  assert.deepEqual(rows.map(row => [row.vehicleId, row.view.kind]), [['V1', 'out'], ['V3', 'stale'], ['GHOST', 'normal'], ['V2', 'none']]);
  assert.equal(rows[0].sensors, 2);
  assert.equal(rows[0].latest.sensorId, 'S2');
  assert.equal(rows.at(-1).view.label, '수신 이력 없음');
  assert.equal(rows.find(row => row.vehicleId === 'GHOST').vehicle, null);
});
