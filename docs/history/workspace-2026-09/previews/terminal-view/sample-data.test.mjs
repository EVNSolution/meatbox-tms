import test from 'node:test';
import assert from 'node:assert/strict';
import { getTerminalSnapshots, filterTerminals, scenarioOptions } from './sample-data.mjs';

test('independent branches start from departure and do not retain prior changes', () => {
  const reordered = getTerminalSnapshots('reordered')[0];
  const traffic = getTerminalSnapshots('traffic')[0];
  const reset = getTerminalSnapshots('departure')[0];
  assert.equal(reordered.sequence, 3);
  assert.equal(traffic.sequence, 5);
  assert.deepEqual(traffic.previousEta, reset.eta);
  assert.equal(reset.changed, false);
  assert.equal(reset.previousEta, null);
  assert.equal(reset.events.some(event => event.kind === 'ETA 변경'), false);
  reordered.eta.start = '00:00';
  assert.equal(getTerminalSnapshots('reordered')[0].eta.start, '12:40');
});

test('unknown, stale and completion preserve distinct time meanings', () => {
  const unknown = getTerminalSnapshots('preparing')[0];
  const stale = getTerminalSnapshots('stale')[0];
  const complete = getTerminalSnapshots('completed')[0];
  assert.equal(unknown.eta, null);
  assert.equal(unknown.sequence, null);
  assert.equal(stale.eta.updatedAt, '11:30');
  assert.equal(stale.updatedAt, '11:30');
  assert.equal(stale.snapshotTime, '11:50');
  assert.equal(stale.refreshFailed, true);
  assert.equal(complete.actualArrivalAt, null);
  assert.equal(complete.completedAt, '13:42');
});

test('filtering changes only the view, with no fabricated device receipt evidence', () => {
  const terminals = getTerminalSnapshots('traffic');
  const original = structuredClone(terminals);
  assert.equal(filterTerminals(terminals, 'tms-001', 'all').length, 1);
  assert.equal(filterTerminals(terminals, '', 'needs_check').length, 2);
  assert.equal(filterTerminals(terminals, '없는 단말', 'all').length, 0);
  assert.deepEqual(terminals, original);
  for (const option of scenarioOptions) {
    for (const terminal of getTerminalSnapshots(option.id)) {
      assert.equal(terminal.deviceConnection, null);
      assert.equal(terminal.deviceReceivedAt, null);
      assert.ok(!terminal.deviceNotice || terminal.deviceNotice.receivedAt === null);
      assert.ok(!terminal.customerNotice || terminal.customerNotice.receivedAt === null);
    }
  }
  assert.throws(() => getTerminalSnapshots('unsupported'));
});
