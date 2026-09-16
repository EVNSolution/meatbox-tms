import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { adaptSimulation } from '../apps/combined/simulation-adapter.mjs';
import { sourceVehicleContext } from '../apps/combined/source-context.mjs';
import { driverViewModel } from '../apps/combined/driver-view-model.mjs';
import {
  customerDeliveryForId,
  customerMapView,
  customerOrderSummary,
  customerViewerDeliveries,
} from '../apps/combined/customer-renderer.mjs';

const require = createRequire(import.meta.url);
const { createDemo } = require('../server.js');

const origin = 'http://127.0.0.1:32123';
const date = '2026-09-16';
const orders = [
  {
    id: 'BUNDLE-1', groupId: 'TRUCK-1', orderNumber: 'MB-1001', name: '한결정육점',
    address: '서울시 강서구 공항대로 10', detailAddress: '1층', boxes: 2, sourceRows: 1,
    sequence: 1, regionCode: 'SEOUL', regionName: '서울', coordinates: [126.81, 37.56], zoneIds: ['WEST'],
  },
  {
    id: 'BUNDLE-2', groupId: 'TRUCK-1', orderNumber: 'MB-1002', name: '한결정육점',
    address: '서울시 강서구 공항대로 10', detailAddress: '1층', boxes: 3, sourceRows: 1,
    sequence: 2, regionCode: 'SEOUL', regionName: '서울', coordinates: [126.81, 37.56], zoneIds: ['WEST'],
  },
  {
    id: 'NEXT-1', groupId: 'TRUCK-1', orderNumber: 'MB-1003', name: '새봄식당',
    address: '서울시 양천구 목동로 20', detailAddress: '2층', boxes: 4, sourceRows: 1,
    sequence: 3, regionCode: 'SEOUL', regionName: '서울', coordinates: [126.87, 37.52], zoneIds: ['WEST'],
  },
];
const summary = {
  sourceRows: 3, boxes: 9, orders: 3, payments: 3, sites: 2, groups: 1,
  mappedOrders: 3, unmappedOrders: 0, uncoveredOrders: 0, multiZoneOrders: 0,
};
const day = {
  schemaVersion: 1,
  date,
  weekday: '수요일',
  summary,
  groups: [{ id: 'TRUCK-1', label: '통합 기사', regionNames: ['서울'] }],
  orders,
};

async function startDemo(paths) {
  const demo = createDemo({
    accessFile: paths.accessFile,
    dispatchDataDir: paths.dispatchDataDir,
    dispatchStateDir: paths.dispatchStateDir,
    origin,
  });
  await new Promise(resolve => demo.server.listen(0, '127.0.0.1', resolve));
  return { demo, base: `http://127.0.0.1:${demo.server.address().port}` };
}

async function loginClients(running, credentialsByView) {
  const clients = {};
  for (const [view, credentials] of Object.entries(credentialsByView)) {
    const session = await running.demo.access.login(credentials);
    const cookie = `meatbox_session=${session.token}`;
    clients[view] = (route, options = {}) => fetch(running.base + route, {
      redirect: 'manual',
      ...options,
      headers: { cookie, 'accept-encoding': 'identity', ...options.headers },
    });
  }
  return clients;
}

test('operator, driver, and customer retain one bundled delivery truth through publish, completion, and restart', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-system-integration-'));
  const paths = {
    accessFile: path.join(root, 'access.json'),
    dispatchDataDir: path.join(root, '.runtime', 'dispatch-data'),
    dispatchStateDir: path.join(root, '.runtime', 'dispatch-state'),
  };
  await fs.mkdir(path.join(paths.dispatchDataDir, 'days'), { recursive: true });
  await fs.writeFile(path.join(paths.dispatchDataDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    defaultDate: date,
    dates: [{ date, weekday: day.weekday, summary }],
    source: { csvSha256: 'synthetic-system-integration', dateShift: { operatingDate: date } },
  }));
  await fs.writeFile(path.join(paths.dispatchDataDir, 'days', `${date}.json`), JSON.stringify(day));
  await fs.writeFile(path.join(paths.dispatchDataDir, 'regions.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [] }));

  let running = await startDemo(paths);
  t.after(async () => {
    await running.demo.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const credentialsByView = {
    operator: { username: 'system-operator', password: 'demo1234' },
    driver: { username: 'system-driver', password: 'demo1234' },
    customer: { username: 'system-customer', password: 'demo1234' },
  };
  for (const credentials of Object.values(credentialsByView)) {
    const invite = await running.demo.access.issueInvite();
    await running.demo.access.register({ ...credentials, invite });
  }
  let clients = await loginClients(running, credentialsByView);
  const stateRoute = `/api/dispatch-data/days/${date}/state`;
  const commandRoute = `/api/dispatch-data/days/${date}/commands`;
  const read = async client => {
    const response = await client(stateRoute);
    assert.equal(response.status, 200);
    return response.json();
  };
  const send = async (state, body) => {
    const response = await clients.operator(commandRoute, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedBoot: state.boot, expectedRevision: state.revision, ...body }),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value.state;
  };

  let state = await read(clients.operator);
  assert.equal(state.dispatch.phase, 'unplanned');
  assert.equal(state.fleetDeliveries.length, 0);

  state = await send(state, { type: 'calculate_dispatch', vehicleIds: ['TRUCK-1'] });
  assert.equal(state.dispatch.phase, 'draft');
  assert.equal(state.fleetDeliveries.length, 0);
  const draftDriver = driverViewModel(sourceVehicleContext(adaptSimulation(await read(clients.driver)), 'BUNDLE-2'));
  const draftCustomer = customerDeliveryForId(customerViewerDeliveries(adaptSimulation(await read(clients.customer))), 'BUNDLE-2');
  assert.equal(draftDriver.deliveries.length, 0);
  assert.equal(draftCustomer.dispatchPending, true);
  assert.equal(draftCustomer.vehicleId, undefined);

  state = await send(state, {
    type: 'publish_dispatch',
    draftVersion: state.dispatch.draftVersion,
  });
  const operatorPublished = adaptSimulation(state);
  const driverPublished = driverViewModel(sourceVehicleContext(adaptSimulation(await read(clients.driver)), 'BUNDLE-2'));
  const customerPublishedState = sourceVehicleContext(adaptSimulation(await read(clients.customer)), 'BUNDLE-2');
  const customerPublished = customerDeliveryForId(customerViewerDeliveries(customerPublishedState), 'BUNDLE-2');
  const operatorBundle = customerDeliveryForId(operatorPublished.fleetDeliveries, 'BUNDLE-2');
  assert.deepEqual(operatorBundle.orderIds, ['BUNDLE-1', 'BUNDLE-2']);
  assert.deepEqual(driverPublished.selected.orderIds, operatorBundle.orderIds);
  assert.deepEqual(customerPublished.orderIds, operatorBundle.orderIds);
  assert.equal(operatorBundle.boxes, 5);
  assert.equal(driverPublished.selected.boxes, 5);
  assert.equal(customerPublished.boxes, 5);
  assert.equal(customerOrderSummary(customerPublished).orderText, 'MB-1001, MB-1002');
  assert.equal(customerDeliveryForId(customerViewerDeliveries(customerPublishedState), 'NEXT-1').status, 'pending');

  state = await send(state, {
    type: 'set_scenario', vehicleId: 'TRUCK-1', stopId: 'BUNDLE-2', scenario: 'shipping',
  });
  state = await send(state, {
    type: 'arrive_stop', vehicleId: 'TRUCK-1', stopId: 'BUNDLE-2',
  });
  const arrivedRevision = state.revision;
  const requiredRequestIds = [...new Set(state.fleetDeliveries
    .filter(order => ['BUNDLE-1', 'BUNDLE-2'].includes(order.id))
    .flatMap(order => order.customerRequests?.items || [])
    .filter(request => request.required)
    .map(request => request.id))];
  assert.ok(requiredRequestIds.length > 0);
  state = await send(state, {
    type: 'complete_stop', vehicleId: 'TRUCK-1', stopId: 'BUNDLE-2', hasPhoto: true, confirmedRequestIds: requiredRequestIds,
  });

  const finalOperator = adaptSimulation(state);
  const finalDriverState = sourceVehicleContext(adaptSimulation(await read(clients.driver)), 'BUNDLE-2');
  const finalDriver = driverViewModel(finalDriverState, true, 'BUNDLE-2');
  const finalCustomerState = sourceVehicleContext(adaptSimulation(await read(clients.customer)), 'BUNDLE-2');
  const finalCustomer = customerDeliveryForId(customerViewerDeliveries(finalCustomerState), 'BUNDLE-2');
  const finalOperatorBundle = customerDeliveryForId(finalOperator.fleetDeliveries, 'BUNDLE-2');
  const completionNotice = finalCustomer.notices.find(notice => notice.kind === 'completed');
  assert.deepEqual(finalOperatorBundle.orders.map(order => [order.id, order.status]), [
    ['BUNDLE-1', 'done'],
    ['BUNDLE-2', 'done'],
  ]);
  assert.equal(finalDriver.selected.status, 'done');
  assert.equal(finalCustomer.status, 'done');
  assert.deepEqual(finalDriver.selected.orderIds, ['BUNDLE-1', 'BUNDLE-2']);
  assert.equal(finalDriver.selected.boxes, 5);
  assert.equal(finalCustomer.boxes, 5);
  assert.ok(completionNotice);
  assert.equal(finalOperator.notifications.some(notice => notice.id === completionNotice.id && notice.kind === 'completed'), true);

  const nextCustomer = customerDeliveryForId(customerViewerDeliveries(finalCustomerState), 'NEXT-1');
  assert.equal(nextCustomer.status, 'current');
  assert.equal(finalDriver.current.id, 'NEXT-1');
  assert.equal(finalDriverState.truck.toId, 'NEXT-1');
  assert.deepEqual([finalDriverState.truck.lng, finalDriverState.truck.lat], orders[0].coordinates);
  assert.notDeepEqual([finalDriverState.truck.lng, finalDriverState.truck.lat], orders[2].coordinates);
  assert.deepEqual(customerMapView(nextCustomer, finalCustomerState).truck, orders[0].coordinates);

  const beforeRestart = {
    revision: state.revision,
    orders: state.fleetDeliveries.map(order => ({ id: order.id, status: order.status })),
    events: state.events,
    notifications: state.notifications,
    vehicleLocation: state.fleetVehicles.find(vehicle => vehicle.id === 'TRUCK-1').location,
    truck: state.vehicleStates['TRUCK-1'].truck,
  };
  await running.demo.close();
  running = await startDemo(paths);
  clients = await loginClients(running, credentialsByView);

  const restored = await read(clients.operator);
  assert.equal(restored.revision, beforeRestart.revision);
  assert.deepEqual(restored.fleetDeliveries.map(order => ({ id: order.id, status: order.status })), beforeRestart.orders);
  assert.deepEqual(restored.events, beforeRestart.events);
  assert.deepEqual(restored.notifications, beforeRestart.notifications);
  assert.deepEqual(restored.fleetVehicles.find(vehicle => vehicle.id === 'TRUCK-1').location, beforeRestart.vehicleLocation);
  assert.deepEqual(restored.vehicleStates['TRUCK-1'].truck, beforeRestart.truck);

  const stale = await clients.operator(commandRoute, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'complete_stop',
      expectedBoot: restored.boot,
      expectedRevision: arrivedRevision,
      vehicleId: 'TRUCK-1',
      stopId: 'BUNDLE-2',
      hasPhoto: true,
      confirmedRequestIds: requiredRequestIds,
    }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'REVISION_CONFLICT');
  const unchanged = await read(clients.operator);
  assert.equal(unchanged.revision, beforeRestart.revision);
  assert.deepEqual(unchanged.events, beforeRestart.events);
  assert.deepEqual(unchanged.notifications, beforeRestart.notifications);
});
