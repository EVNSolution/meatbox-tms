import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriverProfileClient, isEmptyProfile, parseMaster, ProfileError } from './driver-profile-client.ts';
import { formHtml, listHtml, masterMarkup, mountDriverMaster, profileFromValues } from './driver-master.ts';

const row = (over = {}) => ({ username: 'kim', displayName: '김기사', known: true, disabled: false, region: null, skill: null, phone: null, address: null, contract: null, vehicleType: null, topSpec: null, capa: { stops: null, boxes: null, weightKg: null }, ...over });
const payload = (drivers = [row()], revision = 0) => ({ revision, drivers });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a malformed response is rejected and a profile is read with its Capa', () => {
  assert.throws(() => parseMaster({}), /확인할 수 없습니다/);
  const master = parseMaster(payload([row({ region: '강남', capa: { stops: 30, boxes: 120.5, weightKg: null } })], 3));
  assert.equal(master.revision, 3);
  assert.equal(master.drivers[0].region, '강남');
  assert.deepEqual(master.drivers[0].capa, { stops: 30, boxes: 120.5, weightKg: null });
});

test('form values become a profile; blanks are not set and a bad number is told', () => {
  const ok = profileFromValues({ region: ' 강남 ', phone: '', 'capa-stops': '30', 'capa-boxes': '120.5', 'capa-weightKg': '' });
  assert.equal(ok.profile.region, '강남');
  assert.equal(ok.profile.phone, null);
  assert.deepEqual(ok.profile.capa, { stops: 30, boxes: 120.5, weightKg: null });
  assert.match(profileFromValues({ 'capa-stops': '1.5' }).error, /착지수.*정수/);
  assert.match(profileFromValues({ 'capa-weightKg': '-1' }).error, /중량/);
  assert.match(profileFromValues({ 'capa-boxes': 'abc' }).error, /Box/);
  assert.equal(isEmptyProfile(profileFromValues({}).profile), true);
});

test('the list shows what is missing as 미등록·미설정 and escapes text; the privacy note is on the screen', () => {
  assert.match(masterMarkup(), /개인정보/);
  const html = listHtml([row({ region: '<b>강남</b>' })], () => ['G1'], null);
  assert.match(html, /&lt;b&gt;강남/);
  assert.match(html, /착지수 미설정 · Box 수량 미설정 · 중량 미설정/);
  assert.match(html, /G1/);
  assert.match(listHtml([row({ known: false, disabled: true })], () => [], null), /계정 없음/);
  assert.match(listHtml([], () => [], null), /기사 계정이 없습니다/);
  assert.match(formHtml(row({ phone: '010-1' })), /value="010-1"/);
});

function fixture(client) {
  const nodes = new Map();
  const make = () => ({ innerHTML: '', textContent: '', listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } });
  const element = { querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, make()); return nodes.get(selector); } };
  const panel = mountDriverMaster({ element, client, assignedVehicles: user => (user === 'kim' ? ['G1'] : []) });
  const node = selector => nodes.get(selector);
  const click = hook => node('[data-driver-master]').listeners.click({ target: { closest: selector => (selector.includes(hook) ? { dataset: { masterEdit: 'kim' } } : null) } });
  const submit = values => node('[data-driver-master]').listeners.submit({ preventDefault() {}, target: { dataset: { masterForm: 'kim' }, querySelector: selector => ({ value: values[selector.match(/name="([^"]+)"/)[1]] ?? '' }) } });
  return { panel, node, click, submit };
}

test('the list loads, opens the form of one driver and saves the profile with the revision it read', async () => {
  const sent = [];
  let current = payload();
  const fetchImpl = async (url, init) => {
    if (init.method === 'PUT') { sent.push(JSON.parse(init.body)); current = payload([row({ region: '강남', capa: { stops: 30, boxes: null, weightKg: null } })], 1); return { ok: true, status: 200, json: async () => ({ revision: 1 }) }; }
    return { ok: true, status: 200, json: async () => current };
  };
  const { node, click, submit } = fixture(createDriverProfileClient(fetchImpl));
  await flush();
  assert.match(node('[data-master-list]').innerHTML, /김기사/);
  click('[data-master-edit]');
  assert.match(node('[data-master-form-host]').innerHTML, /data-master-form="kim"/);
  submit({ region: '강남', 'capa-stops': '30' });
  await flush(); await flush();
  assert.equal(sent[0].revision, 0);
  assert.equal(sent[0].profile.region, '강남');
  assert.equal(sent[0].profile.capa.stops, 30);
  assert.equal(node('[data-master-message]').textContent, '저장했습니다.');
  assert.equal(node('[data-master-form-host]').innerHTML, '');
  assert.match(node('[data-master-list]').innerHTML, /강남/);
});

test('a lost race reads the newest list and tells; a missing route is worded; clearing every box removes the profile', async () => {
  const calls = [];
  let current = payload([row({ region: '강남' })], 5);
  const fetchImpl = async (url, init) => {
    calls.push(init.method);
    if (init.method === 'PUT' && calls.length === 2) return { ok: false, status: 409, json: async () => ({ code: 'PROFILE_REVISION_CONFLICT' }) };
    return { ok: true, status: 200, json: async () => current };
  };
  const { node, click, submit } = fixture(createDriverProfileClient(fetchImpl));
  await flush();
  click('[data-master-edit]');
  submit({ region: 'x' });
  await flush(); await flush();
  assert.match(node('[data-master-message]').textContent, /다른 변경이 먼저/);
  assert.deepEqual(calls, ['GET', 'PUT', 'GET']);

  const bodies = [];
  const clearing = createDriverProfileClient(async (url, init) => { if (init.method === 'PUT') bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => current }; });
  const second = fixture(clearing);
  await flush();
  second.click('[data-master-edit]');
  second.submit({});
  await flush(); await flush();
  assert.equal(bodies[0].profile, null);

  const missing = fixture(createDriverProfileClient(async () => ({ ok: false, status: 404, json: async () => ({}) })));
  await flush();
  assert.match(missing.node('[data-master-message]').textContent, /이 환경에는/);
  await assert.rejects(createDriverProfileClient(async () => ({ ok: false, status: 403, json: async () => ({}) })).load(), error => error instanceof ProfileError && /운영자 계정/.test(error.message));
});
