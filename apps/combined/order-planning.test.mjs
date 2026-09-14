import test from 'node:test';
import assert from 'node:assert/strict';
import { mountOrderPlanning } from './order-planning.mjs';

class FakeNode {
  constructor() { this.innerHTML = ''; this.value = ''; this.textContent = ''; this.listeners = {}; this.dataset = {}; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  removeEventListener(type) { delete this.listeners[type]; }
  setAttribute(name, value) { this[name] = value; }
  querySelectorAll() { return []; }
}

function fixture() {
  const selectors = ['vehicle', 'box-range', 'box-number', 'box-display', 'total', 'required', 'map-canvas', 'map-count', 'selection'];
  const nodes = Object.fromEntries(selectors.map(name => [name, new FakeNode()]));
  nodes['box-range'].value = '7800';
  nodes['box-number'].value = '7800';
  const element = new FakeNode();
  element.querySelector = selector => nodes[selector.match(/data-order-([^\]]+)/)?.[1]];
  return { element, nodes };
}

test('box editor clamps integer input and calculates 60-box vehicle requirements', () => {
  const { element, nodes } = fixture();
  const planning = mountOrderPlanning({ element });
  nodes['box-number'].listeners.input({ target: { value: '61.9' } });
  assert.equal(nodes['box-number'].value, '61');
  assert.equal(nodes.required.textContent, '2대');
  nodes['box-number'].listeners.input({ target: { value: '9000' } });
  assert.equal(nodes.total.textContent, '7,800박스');
  assert.equal(nodes.required.textContent, '130대');
  nodes['box-number'].listeners.input({ target: { value: '-1' } });
  assert.equal(nodes.required.textContent, '0대');
  planning.destroy();
});

test('focused range uses the wheel in 60-box increments and respects the lower boundary', () => {
  const { element, nodes } = fixture();
  const planning = mountOrderPlanning({ element });
  globalThis.document = { activeElement: nodes['box-range'] };
  nodes['box-number'].listeners.input({ target: { value: '30' } });
  let prevented = false;
  nodes['box-range'].listeners.wheel({ deltaX: 0, deltaY: 1, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(nodes['box-number'].value, '0');
  nodes['box-range'].listeners.wheel({ deltaX: 0, deltaY: -1, preventDefault() {} });
  assert.equal(nodes['box-number'].value, '60');
  nodes['box-range'].listeners.wheel({ deltaX: 1, deltaY: 0, preventDefault() {} });
  assert.equal(nodes['box-number'].value, '120');
  delete globalThis.document;
  planning.destroy();
});

test('vehicle choice and planning volume survive live updates without rebuilding unchanged controls', () => {
  const { element, nodes } = fixture();
  const planning = mountOrderPlanning({ element });
  const data = {
    vehicle: { id: 'V1', plate: '서울 01가 1001' },
    fleetVehicles: [{ id: 'V1', plate: '서울 01가 1001' }, { id: 'V2', plate: '서울 01가 1002' }],
    fleetDeliveries: [
      { id: 'S1', vehicleId: 'V1', name: '정육점 1', boxes: 60 },
      { id: 'S2', vehicle: { id: 'V2' }, name: '정육점 2', boxes: 30 },
    ],
  };
  planning.update(data, 'S2');
  assert.equal(nodes.vehicle.value, 'V2');
  assert.match(nodes['map-canvas'].innerHTML, /S2/);
  assert.doesNotMatch(nodes['map-canvas'].innerHTML, /S1/);
  nodes.vehicle.listeners.change({ target: { value: 'V1' } });
  planning.update({ ...data, simClock: '06:09' }, 'S2');
  assert.equal(nodes.vehicle.value, 'V1');
  assert.match(nodes['map-canvas'].innerHTML, /S1/);
  assert.doesNotMatch(nodes['map-canvas'].innerHTML, /S2/);
  nodes['box-number'].listeners.input({ target: { value: '125' } });
  planning.update({ ...data, simClock: '06:10' }, 'S2');
  assert.equal(nodes.vehicle.value, 'V1');
  assert.equal(nodes['box-number'].value, '125');
  assert.equal(nodes.required.textContent, '3대');
  planning.destroy();
});
