import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { HistoryItem } from '../api/driverContracts';
import { groupStops, type FleetDelivery } from './dispatch';
import { historyRows } from './historyView';

const delivery = (id: string, name: string): FleetDelivery => ({
  id, vehicleId: 'G1', name, address: `${name} 주소`, boxes: 1, sequence: Number(id.slice(1)), status: 'done',
});
const stops = groupStops([delivery('O1', '가게A'), delivery('O2', '가게A'), delivery('O3', '가게B')]);
const item = (stopId: string, result: HistoryItem['result'], completedAt: string | null, extra: Partial<HistoryItem> = {}): HistoryItem => ({
  stopId, result, completedAt, reasonCode: null, note: null, photoIds: [], scannedCodes: [], ...extra,
});

test('rows are newest first with the stop name, Seoul time, reason label, note and photo count', () => {
  const rows = historyRows([
    item('O1', 'completed', '2026-11-02T09:10:00+09:00', { photoIds: ['p1', 'p2'], note: ' 문 앞 ', scannedCodes: ['880', '881'] }),
    item('O3', 'failed', '2026-11-02T01:30:00Z', { reasonCode: 'ABSENT', note: '부재' }),
  ], stops);
  assert.deepEqual(rows, [
    { key: 'O3', name: '가게B', result: '미배송', tone: 'failed', time: '10:30', reason: '고객 부재', note: '부재', photos: 0, codes: 0 },
    { key: 'O1', name: '가게A', result: '배송 완료', tone: 'done', time: '09:10', reason: null, note: '문 앞', photos: 2, codes: 2 },
  ]);
});

test('an unknown stop shows its ID, an unknown reason shows its code, and a missing time sorts last', () => {
  const rows = historyRows([
    item('ZZ', 'partially_completed', null, { reasonCode: 'NEW_CODE' }),
    item('O1', 'completed', '2026-11-02T09:10:00+09:00'),
  ], stops);
  assert.deepEqual(rows.map((row) => [row.key, row.name, row.time, row.reason, row.tone]), [
    ['O1', '가게A', '09:10', null, 'done'],
    ['ZZ', 'ZZ', null, 'NEW_CODE', 'partial'],
  ]);
  assert.deepEqual(historyRows([], stops), []);
});
