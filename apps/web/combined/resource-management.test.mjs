import test from 'node:test';
import assert from 'node:assert/strict';
import { mountResourceManagement, resourceManagementModel } from './resource-management.mjs';

const snapshot = { revision: 1, regionCodes: [{ code: 'Z003' }, { code: 'Z004' }, { code: 'A01' }], vehicles: [
  { id: 'G1', plate: '서울 1', regionCode: 'Z003' }, { id: 'G2', plate: '서울 2', regionCode: 'Z004' }, { id: 'G3', plate: '서울 3', regionCode: null },
] };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(client = { snapshot, load: async () => snapshot, assignVehicles: async () => snapshot }) {
  const element = {
    innerHTML: '', listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    removeEventListener(name) { delete this.listeners[name]; },
    querySelector() { return { focus() {}, setSelectionRange() {} }; },
  };
  const instance = mountResourceManagement({ element, client });
  const input = (dataset, value) => element.listeners.input({ target: { dataset, value, selectionStart: value.length } });
  const change = (dataset, value) => element.listeners.change({ target: { dataset, value } });
  const click = action => element.listeners.click({ target: { closest: () => ({ dataset: { resourceAction: action } }) } });
  const submit = form => element.listeners.submit({ target: { closest: () => form }, preventDefault() {} });
  return { element, client, instance, input, change, click, submit };
}

test('model uses registry and saved-field filters; drafts preserve visible row', () => {
  const model = resourceManagementModel({ ...snapshot, fleetVehicles: [{ id: 'BAD' }] }, { query: 'Z003', drafts: new Map([['G1', 'A01']]) });
  assert.deepEqual(model.visibleVehicles.map(item => item.id), ['G1']);
  assert.equal(model.visibleVehicles[0].effectiveRegionCode, 'A01');
  assert.deepEqual(model.regionCodes.map(item => item.code), ['Z003', 'Z004', 'A01']);
});

test('default UI is one compact table with row selects and no free-text region editor', async () => {
  const { element } = fixture(); await tick();
  assert.match(element.innerHTML, /<table/);
  assert.equal((element.innerHTML.match(/data-resource-row=/g) || []).length, 3);
  assert.match(element.innerHTML, /<select data-resource-region-select/);
  assert.doesNotMatch(element.innerHTML, /data-resource-region-input|resource-category-panel|배송지|주문|박스/);
  assert.match(element.innerHTML, /지역 코드 관리/);
  assert.match(element.innerHTML, /resource-toolbar-actions[\s\S]*resource-toolbar-meta/);
});

test('same region on two vehicles is a valid draft and one save includes hidden rows', async () => {
  const calls = [];
  const client = { snapshot, load: async () => snapshot, assignVehicles: async assignments => { calls.push(assignments); return snapshot; } };
  const { element, change, input, click } = fixture(client); await tick();
  change({ resourceRegionSelect: 'G1' }, 'A01');
  change({ resourceRegionSelect: 'G2' }, 'A01');
  assert.match(element.innerHTML, /변경 2건 저장/);
  assert.match(element.innerHTML, /data-resource-action="save" >/);
  input({ resourceSearch: '' }, '서울 3');
  change({ resourceStatusFilter: '' }, 'unassigned');
  assert.equal((element.innerHTML.match(/data-resource-row=/g) || []).length, 1);
  await click('save');
  assert.deepEqual(calls, [[{ id: 'G1', regionCode: 'A01' }, { id: 'G2', regionCode: 'A01' }]]);
});

test('returning to saved selection removes draft; empty option sets null', async () => {
  const { element, change } = fixture(); await tick();
  change({ resourceRegionSelect: 'G1' }, 'A01');
  change({ resourceRegionSelect: 'G1' }, 'Z003');
  assert.match(element.innerHTML, /변경 0건 저장/);
  change({ resourceRegionSelect: 'G1' }, '');
  assert.match(element.innerHTML, /미지정/);
  assert.match(element.innerHTML, /변경 1건 저장/);
});

test('category panel opens on demand, focuses, and locks mutations while vehicle drafts exist', async () => {
  const { element, click, change } = fixture(); await tick();
  assert.doesNotMatch(element.innerHTML, /data-resource-region-panel/);
  click('regions');
  assert.match(element.innerHTML, /data-resource-region-panel/);
  assert.match(element.innerHTML, /resource-region-action[\s\S]*data-resource-region-panel/);
  change({ resourceRegionSelect: 'G1' }, 'A01');
  assert.match(element.innerHTML, /차량 변경을 저장하거나 취소/);
  assert.match(element.innerHTML, /data-resource-form="create"/);
});

test('failed region-code creation preserves typed input for retry', async () => {
  const client = { snapshot, load: async () => snapshot, createRegionCode: async () => { throw new Error('이미 등록된 지역 코드입니다.'); } };
  const { element, click, submit } = fixture(client); await tick(); click('regions');
  await submit({ dataset: { resourceForm: 'create' }, elements: { code: { value: 'QA77' } } });
  assert.match(element.innerHTML, /value="QA77"/);
  assert.match(element.innerHTML, /이미 등록된 지역 코드/);
});

test('CAS conflict retains drafts until explicit discard, with reload path', async () => {
  const client = { snapshot, load: async () => snapshot, assignVehicles: async () => { const error = new Error('다른 변경이 먼저 저장됐습니다.'); error.code = 'RESOURCE_REVISION_CONFLICT'; throw error; } };
  const { element, change, click } = fixture(client); await tick();
  change({ resourceRegionSelect: 'G1' }, 'A01');
  await click('save');
  assert.match(element.innerHTML, /변경 1건 저장/);
  assert.match(element.innerHTML, /다시 불러오기/);
  click('discard'); click('confirm-discard');
  assert.match(element.innerHTML, /변경 0건 저장/);
});
