import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceClient } from './resource-client.mjs';

const snapshot = revision => ({ revision, regionCodes: [{ code: 'Z003' }, { code: 'Z004' }, { code: 'A01' }], vehicles: [{ id: 'G1', plate: '서울 1', regionCode: 'Z003' }, { id: 'G2', plate: '서울 2', regionCode: 'Z004' }] });
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('same region can be selected for two vehicles in one authenticated atomic PATCH', async () => {
  const calls = [];
  const client = createResourceClient({ fetchImpl: async (url, options) => { calls.push([url, options]); return response(200, snapshot(calls.length)); } });
  await client.load();
  await client.assignVehicles([{ id: 'G1', regionCode: 'A01' }, { id: 'G2', regionCode: 'A01' }]);
  assert.deepEqual(calls.map(([url, options]) => [url, options.method, options.credentials]), [
    ['/api/resources', 'GET', 'same-origin'], ['/api/resources/vehicles', 'PATCH', 'same-origin'],
  ]);
  assert.deepEqual(JSON.parse(calls[1][1].body), { revision: 1, assignments: [{ id: 'G1', regionCode: 'A01' }, { id: 'G2', regionCode: 'A01' }] });
});

test('region-code create/rename use current revision and category endpoints', async () => {
  const calls = [];
  const client = createResourceClient({ fetchImpl: async (url, options) => { calls.push([url, options]); return response(200, snapshot(calls.length)); } });
  await client.load(); await client.createRegionCode('B01'); await client.renameRegionCode('B01', 'B02');
  assert.deepEqual(calls.slice(1).map(([url, options]) => [url, options.method, JSON.parse(options.body)]), [
    ['/api/resources/region-codes', 'POST', { revision: 1, code: 'B01' }],
    ['/api/resources/region-codes/B01', 'PATCH', { revision: 2, code: 'B02' }],
  ]);
});

test('duplicate category, invalid code and stale revision have distinct safe errors', async () => {
  for (const [status, error, pattern] of [[409, 'REGION_CODE_EXISTS', /이미 등록/], [400, 'INVALID_REGION_CODE', /영문/], [409, 'RESOURCE_REVISION_CONFLICT', /다른 변경/]]) {
    const client = createResourceClient({ fetchImpl: async (_url, options) => options.method === 'GET' ? response(200, snapshot(1)) : response(status, { error }) });
    await client.load();
    await assert.rejects(client.createRegionCode('B01'), cause => cause.code === error && pattern.test(cause.message));
    assert.equal(client.snapshot.revision, 1);
  }
});

test('malformed category-free snapshot is rejected', async () => {
  await assert.rejects(createResourceClient({ fetchImpl: async () => response(200, { revision: 1, vehicles: [] }) }).load(), /자료/);
});
