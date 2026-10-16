import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FleetDelivery } from './dispatch';
import { cleanCode, expectedScanItems, hasScanMismatch, isRapidRepeat, matchScan, summarizeScans } from './scanMatch';
import { MAX_SCANNED_CODES } from './scanPolicy';

const order = (id: string, items: FleetDelivery['items']): FleetDelivery => ({
  id, vehicleId: 'G1', name: '가게', address: '서울', boxes: 1, sequence: 1, status: 'current', items,
});
const orders = [
  order('O1', [{ sku: 'PK-001', name: '삼겹살', qty: 3, barcode: '8801234567890' }, { sku: 'PK-002', name: '목살', qty: 2 }]),
  order('O2', [{ sku: 'PK-003', name: '항정살', qty: 1, barcode: 'ab-12 34' }, { sku: 'PK-001', name: '삼겹살', qty: 1, barcode: '8801234567890' }]),
];
const items = expectedScanItems(orders);

test('only items with a barcode are expected; none at all means the check is skipped', () => {
  assert.deepEqual(items.map((item) => [item.orderId, item.sku, item.name]), [['O1', 'PK-001', '삼겹살'], ['O2', 'PK-003', '항정살'], ['O2', 'PK-001', '삼겹살']]);
  assert.deepEqual(expectedScanItems([order('O1', [{ sku: 'S', qty: 1 }]), order('O2', null), order('O3', [{ sku: 'S', barcode: '  ' }])]), []);
});

test('a reading that equals an item barcode matches every item with that barcode', () => {
  const result = matchScan('8801234567890', items, []);
  assert.equal(result.kind, 'matched');
  if (result.kind === 'matched') assert.deepEqual(result.items.map((item) => item.orderId), ['O1', 'O2']);
});

test('spaces, hyphens and case do not matter when comparing, and the code is kept without spaces', () => {
  const result = matchScan(' AB 1234\n', items, []);
  assert.equal(result.kind, 'matched');
  if (result.kind === 'matched') assert.equal(result.code, 'AB1234');
  assert.equal(matchScan('ab-1234', items, []).kind, 'matched');
  assert.equal(cleanCode(' 88 01\t23 '), '880123');
});

test('a code that is not one of the stop barcodes is unregistered; a second reading of a taken code is a duplicate', () => {
  assert.deepEqual(matchScan('9999999999999', items, []), { kind: 'unregistered', code: '9999999999999' });
  assert.deepEqual(matchScan('8801234567890', items, ['8801234567890']), { kind: 'duplicate', code: '8801234567890' });
  assert.deepEqual(matchScan('88-01234567890', items, ['8801234567890']), { kind: 'duplicate', code: '88-01234567890' });
  assert.deepEqual(matchScan('9999999999999', items, ['9999999999999']), { kind: 'duplicate', code: '9999999999999' });
});

test('empty, too long and over-the-limit readings are invalid', () => {
  assert.deepEqual(matchScan('  ', items, []), { kind: 'invalid' });
  assert.deepEqual(matchScan('1'.repeat(129), items, []), { kind: 'invalid' });
  assert.deepEqual(matchScan('777', items, Array.from({ length: MAX_SCANNED_CODES }, (_unused, index) => `C${index}`)), { kind: 'invalid' });
});

test('the summary lists items read and not read and the codes that belong to nothing', () => {
  const summary = summarizeScans(items, ['8801234567890', '1234567']);
  assert.deepEqual(summary.items.map((item) => [item.sku, item.read]), [['PK-001', true], ['PK-003', false], ['PK-001', true]]);
  assert.deepEqual(summary.missing.map((item) => item.sku), ['PK-003']);
  assert.deepEqual(summary.unregistered, ['1234567']);
  assert.equal(hasScanMismatch(summary), true);
  assert.equal(hasScanMismatch(summarizeScans(items, ['8801234567890', 'AB1234'])), false);
});

test('a repeat of the previous reading inside the burst window is ignored, later or different ones are not', () => {
  assert.equal(isRapidRepeat(null, 'A', 1000), false);
  assert.equal(isRapidRepeat({ code: 'A', at: 1000 }, 'A', 2000), true);
  assert.equal(isRapidRepeat({ code: 'A', at: 1000 }, 'A', 2600), false);
  assert.equal(isRapidRepeat({ code: 'A', at: 1000 }, 'B', 1100), false);
});
