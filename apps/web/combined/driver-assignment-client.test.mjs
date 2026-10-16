import test from 'node:test';
import assert from 'node:assert/strict';
import { AssignmentError, createDriverAssignmentClient, parseAssignments } from './driver-assignment-client.ts';

const list = (revision = 3, extra = {}) => ({
  revision, assignments: [{ vehicleId: 'G1', driver: 'kim', known: true }],
  drivers: [{ username: 'kim', displayName: '김기사', disabled: false }, { username: 'lee', displayName: '이기사', disabled: true }], ...extra,
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the list is validated and a malformed answer is refused', () => {
  assert.equal(parseAssignments(list()).drivers[1].disabled, true);
  assert.throws(() => parseAssignments({}), /기사 배정 응답/);
  assert.throws(() => parseAssignments(list(3, { assignments: [{ vehicleId: 'G1' }] })), /기사 배정 응답/);
  assert.throws(() => parseAssignments(list(1.5)), /기사 배정 응답/);
});

test('a change is one PUT of the revision that was read, and the list follows the answer', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return init.method === 'PUT' ? json({ revision: 4, vehicleId: 'G 2', driver: 'kim' }) : json(list());
  });
  const client = createDriverAssignmentClient();
  await client.load();
  const next = await client.assign('G 2', 'kim');
  assert.equal(calls[1].url, '/api/ops/driver-assignments/G%202');
  assert.deepEqual(JSON.parse(calls[1].init.body), { revision: 3, driver: 'kim' });
  assert.equal(calls[1].init.credentials, 'same-origin');
  assert.deepEqual([next.revision, next.assignments.map(item => item.vehicleId)], [4, ['G1', 'G 2']]);
  const cleared = await client.assign('G1', null);
  assert.deepEqual(JSON.parse(calls[2].init.body), { revision: 4, driver: null });
  assert.deepEqual(cleared.assignments.map(item => item.vehicleId), ['G 2']);
});

test('a lost race is told and the newest list is read, never overwritten', async () => {
  let reads = 0;
  const client = createDriverAssignmentClient(async (url, init) => {
    if (init.method === 'PUT') return json({ code: 'ASSIGNMENT_REVISION_CONFLICT', error: 'ASSIGNMENT_REVISION_CONFLICT' }, 409);
    reads += 1;
    return json(list(reads === 1 ? 3 : 9));
  });
  await client.load();
  await assert.rejects(client.assign('G2', 'kim'), error => error instanceof AssignmentError && error.conflict && /다시 불러왔으니/.test(error.message));
  assert.equal(reads, 2);
  assert.equal(client.snapshot.revision, 9);
});

test('refusals are named by their code, and a missing route is unavailable rather than empty', async () => {
  const failing = (status, code) => createDriverAssignmentClient(async (url, init) => (init.method === 'PUT' ? json({ code }, status) : json(list())));
  for (const [status, code, text] of [[400, 'DRIVER_NOT_FOUND', /찾을 수 없거나 비활성/], [403, 'ROLE_FORBIDDEN', /운영자 계정만/], [500, 'DRIVER_ASSIGNMENTS_INVALID', /손상/]]) {
    const client = failing(status, code);
    await client.load();
    await assert.rejects(client.assign('G1', 'kim'), error => text.test(error.message) && error.status === status);
  }
  const absent = createDriverAssignmentClient(async () => json({ code: 'NOT_FOUND' }, 404));
  await assert.rejects(absent.load(), error => error.unavailable === true && /기사 배정 기능이 없습니다/.test(error.message));
  const offline = createDriverAssignmentClient(async () => { throw new TypeError('network'); });
  await assert.rejects(offline.load(), error => error.status === 0 && /연결 상태/.test(error.message));
  await assert.rejects(createDriverAssignmentClient(async () => json(list())).assign('G1', 'kim'), /먼저 불러와/);
});
