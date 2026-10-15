import test from 'node:test';
import assert from 'node:assert/strict';
import { mountResourceManagement, resourceManagementModel } from './resource-management.mjs';

const snapshot = { revision: 1, regionCodes: [{ code: 'Z003' }, { code: 'Z004' }, { code: 'A01' }], vehicles: [
  { id: 'G1', plate: '서울 1', regionCode: 'Z003' }, { id: 'G2', plate: '서울 2', regionCode: 'Z004' }, { id: 'G3', plate: '서울 3', regionCode: null },
] };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(client = { snapshot, load: async () => snapshot, assignVehicles: async () => snapshot }, options = {}) {
  const element = {
    innerHTML: '', listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    removeEventListener(name) { delete this.listeners[name]; },
    querySelector() { return { focus() {}, setSelectionRange() {} }; },
  };
  const instance = mountResourceManagement({ element, client, ...options });
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

test('initial loading and failed lookup keep the table and actions without reporting zero vehicles', async () => {
  let rejectLoad;
  let loadCalls = 0;
  let writeCalls = 0;
  const client = {
    snapshot: null,
    load() {
      if (++loadCalls === 1) return new Promise((resolve, reject) => { rejectLoad = reject; });
      this.snapshot = snapshot;
      return Promise.resolve(snapshot);
    },
    createRegionCode: async () => { writeCalls += 1; },
  };
  const { element, instance, submit } = fixture(client);
  assert.match(element.innerHTML, /표시 미확인 \/ 전체 미확인 \/ 미지정 미확인/);
  assert.match(element.innerHTML, /aria-busy="true"[\s\S]*<table[\s\S]*resource-actionbar/);
  assert.match(element.innerHTML, /data-resource-search[^>]*disabled/);
  await submit({ dataset: { resourceForm: 'create' }, elements: { code: { value: 'QA77' } } });
  assert.equal(writeCalls, 0);
  rejectLoad(new Error('자원 조회 연결이 끊겼습니다.'));
  await tick();
  assert.match(element.innerHTML, /자원 조회 연결이 끊겼습니다/);
  assert.match(element.innerHTML, /data-resource-action="refresh" >다시 불러오기/);
  assert.match(element.innerHTML, /표시 미확인[\s\S]*<table[\s\S]*resource-actionbar/);
  await instance.refresh();
  assert.match(element.innerHTML, /표시 3 \/ 전체 3대 \/ 미지정 1대/);
  assert.doesNotMatch(element.innerHTML, /data-resource-search[^>]*disabled/);
});

test('successful empty catalog reports zero; a filtered empty result does not report an empty catalog', async () => {
  const emptyChanges = [];
  let loadedSnapshot = { revision: 1, regionCodes: [], vehicles: [] };
  const client = { snapshot: null, async load() { this.snapshot = loadedSnapshot; return loadedSnapshot; } };
  const { element, instance, input } = fixture(client, { onEmptyChange: empty => emptyChanges.push(empty) });
  await tick();
  assert.match(element.innerHTML, /표시 0 \/ 전체 0대 \/ 미지정 0대/);
  assert.match(element.innerHTML, /<td class="resource-empty" colspan="4">미등록<\/td>/);
  assert.match(element.innerHTML, /<table[\s\S]*resource-actionbar/);
  assert.deepEqual(emptyChanges, [false, true]);
  loadedSnapshot = snapshot;
  await instance.refresh();
  input({ resourceSearch: '' }, '검색에 없는 차량');
  assert.match(element.innerHTML, /표시 0 \/ 전체 3대/);
  assert.match(element.innerHTML, /검색 결과 없음/);
  assert.deepEqual(emptyChanges, [false, true, false]);
});

test('failed refresh blocks writes from a cached snapshot and restores the existing draft after retry', async () => {
  let loadCalls = 0;
  let regionWrites = 0;
  const assignments = [];
  const client = {
    snapshot,
    async load() { if (++loadCalls === 2) throw new Error('자원 재조회 실패'); return snapshot; },
    async assignVehicles(values) { assignments.push(values); return snapshot; },
    async createRegionCode() { regionWrites += 1; },
  };
  const { element, instance, change, click, submit } = fixture(client);
  await tick();
  change({ resourceRegionSelect: 'G1' }, 'A01');
  await instance.refresh();
  assert.match(element.innerHTML, /전체 미확인/);
  assert.match(element.innerHTML, /변경 1건 저장/);
  assert.match(element.innerHTML, /data-resource-action="save" disabled/);
  assert.doesNotMatch(element.innerHTML, /data-resource-row=/);
  await click('save');
  await submit({ dataset: { resourceForm: 'create' }, elements: { code: { value: 'QA77' } } });
  assert.deepEqual(assignments, []);
  assert.equal(regionWrites, 0);
  await instance.refresh();
  assert.match(element.innerHTML, /표시 3 \/ 전체 3대/);
  assert.match(element.innerHTML, /data-resource-row="G1" data-changed="true"/);
  assert.match(element.innerHTML, /data-resource-action="save" >/);
  await click('save');
  assert.deepEqual(assignments, [[{ id: 'G1', regionCode: 'A01' }]]);
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

test('failed region-code creation preserves typed input and requires fresh lookup before retry', async () => {
  let writeCalls = 0;
  const client = { snapshot, load: async () => snapshot, createRegionCode: async () => { writeCalls += 1; throw new Error('이미 등록된 지역 코드입니다.'); } };
  const { element, instance, click, submit } = fixture(client); await tick(); click('regions');
  const form = { dataset: { resourceForm: 'create' }, elements: { code: { value: 'QA77' } } };
  await submit(form);
  assert.match(element.innerHTML, /value="QA77"/);
  assert.match(element.innerHTML, /이미 등록된 지역 코드/);
  assert.match(element.innerHTML, /전체 미확인/);
  assert.match(element.innerHTML, /value="QA77"[^>]*disabled/);
  await submit(form);
  assert.equal(writeCalls, 1);
  await instance.refresh();
  assert.match(element.innerHTML, /value="QA77"/);
  assert.doesNotMatch(element.innerHTML, /value="QA77"[^>]*disabled/);
  await submit(form);
  assert.equal(writeCalls, 2);
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
