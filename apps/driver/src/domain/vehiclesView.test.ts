import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { VehicleList } from '../api/driverContracts';
import { vehicleChoices } from './vehiclesView';

const list = (vehicles: VehicleList['vehicles']): VehicleList => ({ date: '2026-11-02', dispatchPhase: 'published', operable: true, vehicles });
const row = (vehicleId: string, extra: Partial<VehicleList['vehicles'][number]> = {}): VehicleList['vehicles'][number] => ({
  vehicleId, label: null, plate: null, region: null, phase: 'idle', stops: 0, orders: 0, ...extra,
});

test('a row shows the driver label, plate and region, the counts and the phase', () => {
  const [choice] = vehicleChoices(list([row('G1', { label: '(Z001) 기사', plate: '12가 3456', region: '서울 강서', phase: 'delivering', stops: 12, orders: 31 })]));
  assert.deepEqual(choice, { vehicleId: 'G1', title: '(Z001) 기사', subtitle: '12가 3456 (미검증) · 서울 강서', counts: '배송지 12곳 · 주문 31건', phase: '배송 중' });
});

test('a vehicle without label, plate or region falls back to its ID and has no subtitle', () => {
  const [choice] = vehicleChoices(list([row('G7')]));
  assert.deepEqual([choice.title, choice.subtitle, choice.phase], ['G7', null, '대기']);
});

test('vehicles with stops come first and keep the server order among themselves', () => {
  const ids = vehicleChoices(list([row('A'), row('B', { stops: 1 }), row('C'), row('D', { stops: 2 })])).map((choice) => choice.vehicleId);
  assert.deepEqual(ids, ['B', 'D', 'A', 'C']);
});
