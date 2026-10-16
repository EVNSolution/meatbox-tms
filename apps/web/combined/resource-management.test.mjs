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

// --- 기사 배정 열 ---
const accounts = {
  revision: 3,
  assignments: [{ vehicleId: 'G1', driver: 'kim', known: true }, { vehicleId: 'G2', driver: 'gone', known: false }],
  drivers: [{ username: 'kim', displayName: '김기사', disabled: false }, { username: 'lee', displayName: '이기사', disabled: false }, { username: 'old', displayName: '퇴사', disabled: true }],
};
function assignmentStub(extra = {}) {
  const calls = [];
  const stub = {
    snapshot: null, calls,
    async load() { calls.push(['load']); this.snapshot = structuredClone(accounts); return this.snapshot; },
    async assign(vehicleId, driver) {
      calls.push(['assign', vehicleId, driver]);
      const others = this.snapshot.assignments.filter(item => item.vehicleId !== vehicleId);
      this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1, assignments: driver ? [...others, { vehicleId, driver, known: true }] : others };
      return this.snapshot;
    },
    ...extra,
  };
  return stub;
}
const driverSelect = html => id => html.match(new RegExp(`<select data-resource-driver-select="${id}"[\\s\\S]*?</select>`))?.[0];

test('각 차량 행에 담당 기사 선택이 있고 배정되지 않은 차량과 계정 상태를 문구로 보여 준다', async () => {
  const stub = assignmentStub();
  const { element } = fixture(undefined, { assignmentClient: stub }); await tick();
  const html = element.innerHTML;
  assert.match(html, /<th scope="col">기사<\/th><th scope="col">변경<\/th>/);
  assert.match(html, /기사 미배정 1대/);
  const g1 = driverSelect(html)('G1');
  assert.match(g1, /<option value="kim" selected>김기사 \(kim\)<\/option>/);
  assert.match(g1, /<option value="lee" >이기사 \(lee\)<\/option>/);
  assert.doesNotMatch(g1, /퇴사|old/, '비활성 계정은 새로 고를 수 없다');
  assert.match(driverSelect(html)('G3'), /<option value="" selected>미배정<\/option>/);
  assert.match(driverSelect(html)('G2'), /<option value="gone" selected>gone \(계정 없음\)<\/option>/);
  assert.match(html, /이 계정으로는 기사 앱을 쓸 수 없습니다/);
});

test('다른 기사를 고르면 바로 저장하고 기사 앱에 바로 적용된다고 알린다', async () => {
  const stub = assignmentStub();
  const { element, change } = fixture(undefined, { assignmentClient: stub }); await tick();
  await change({ resourceDriverSelect: 'G3' }, 'lee'); await tick();
  assert.deepEqual(stub.calls.at(-1), ['assign', 'G3', 'lee']);
  assert.match(element.innerHTML, /data-kind="saved" role="status">저장됨\. 기사 앱에 바로 적용됩니다\./);
  assert.match(driverSelect(element.innerHTML)('G3'), /<option value="lee" selected>/);
  assert.match(element.innerHTML, /기사 미배정 0대/);
});

test('해제는 확인을 한 번 거치고 취소하면 아무것도 저장하지 않는다', async () => {
  const stub = assignmentStub();
  const { element, change, click } = fixture(undefined, { assignmentClient: stub }); await tick();
  const before = stub.calls.length;
  await change({ resourceDriverSelect: 'G1' }, ''); await tick();
  assert.equal(stub.calls.length, before, '선택만으로는 저장하지 않는다');
  assert.match(element.innerHTML, /role="group" aria-label="기사 배정 해제 확인"><span>kim 기사에게서 서울 1 \(미검증\) 차량을 해제합니다\. 기사 앱에서 이 차량을 바로 볼 수 없게 됩니다\./);
  assert.match(driverSelect(element.innerHTML)('G1'), /disabled/, '확인 중에는 다른 행도 잠근다');
  await click('cancel-release'); await tick();
  assert.doesNotMatch(element.innerHTML, /기사 배정 해제 확인/);
  assert.equal(stub.calls.length, before);
  await change({ resourceDriverSelect: 'G1' }, ''); await click('confirm-release'); await tick();
  assert.deepEqual(stub.calls.at(-1), ['assign', 'G1', null]);
  assert.match(element.innerHTML, /해제됨\. 기사 앱에서 바로 막혔습니다\./);
});

test('저장 실패는 그 행에 이유를 적고 목록을 바꾸지 않으며, 충돌은 최신 목록 안내를 보인다', async () => {
  const stub = assignmentStub({ async assign() { throw Object.assign(new Error('다른 변경이 먼저 저장됐습니다. 최신 배정을 다시 불러왔으니 확인한 뒤 다시 선택해 주세요.'), { conflict: true }); } });
  const { element, change } = fixture(undefined, { assignmentClient: stub }); await tick();
  await change({ resourceDriverSelect: 'G3' }, 'lee'); await tick();
  assert.match(element.innerHTML, /data-kind="failed" role="status">다른 변경이 먼저 저장됐습니다\./);
  assert.match(driverSelect(element.innerHTML)('G3'), /<option value="" selected>미배정<\/option>/);
});

test('기사 배정을 읽지 못하면 열은 미확인이고 지역 코드 편집은 계속 된다, 다시 불러오면 회복한다', async () => {
  let fail = true;
  const stub = assignmentStub({ async load() { if (fail) throw new Error('이 환경에는 기사 배정 기능이 없습니다.'); this.snapshot = structuredClone(accounts); return this.snapshot; } });
  const { element, click } = fixture(undefined, { assignmentClient: stub }); await tick();
  assert.match(element.innerHTML, /data-resource-driver-state="error">미확인/);
  assert.match(element.innerHTML, /이 환경에는 기사 배정 기능이 없습니다\./);
  assert.match(element.innerHTML, /<select data-resource-region-select="G1"[^>]*>/);
  assert.doesNotMatch(element.innerHTML, /<select data-resource-region-select="G1"[^>]*disabled/);
  fail = false;
  await click('refresh-drivers'); await tick();
  assert.match(element.innerHTML, /<select data-resource-driver-select="G1"/);
});

test('기사 계정이 하나도 없으면 만드는 방법을 안내하고, 검색은 기사 이름도 찾는다', async () => {
  const empty = assignmentStub({ async load() { this.snapshot = { revision: 0, assignments: [], drivers: [] }; return this.snapshot; } });
  const { element: bare } = fixture(undefined, { assignmentClient: empty }); await tick();
  assert.match(bare.innerHTML, /기사 계정이 없습니다\. 운영 절차의 기사 초대로 계정을 만든 뒤 다시 불러와 주세요\./);
  const model = resourceManagementModel(snapshot, { query: '김기사', drivers: new Map([['G2', 'kim 김기사']]) });
  assert.deepEqual(model.visibleVehicles.map(item => item.id), ['G2']);
});

test('기사 배정 클라이언트가 없으면 열이 없다', async () => {
  const { element } = fixture(); await tick();
  assert.doesNotMatch(element.innerHTML, /기사<\/th>|resource-driver/);
});
