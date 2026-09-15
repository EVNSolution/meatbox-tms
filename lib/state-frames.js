'use strict';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
const serialized = value => JSON.stringify(value);

function deliveryIndex(deliveries) {
  if (!Array.isArray(deliveries)) return null;
  const records = new Map();
  const strings = new Map();
  const order = [];
  for (const record of deliveries) {
    if (!plainObject(record) || !own(record, 'id') || !validId(record.id) || records.has(record.id)) return null;
    records.set(record.id, record);
    strings.set(record.id, serialized(record));
    order.push(record.id);
  }
  return { records, strings, order };
}

function comparable(state) {
  const top = new Map();
  for (const [key, value] of Object.entries(state)) {
    if (key !== 'fleet') top.set(key, serialized(value));
  }

  const fleetValue = state.fleet;
  if (!plainObject(fleetValue) || !Array.isArray(fleetValue.deliveries)) {
    return { state, top, fleetValue, fleetString: serialized(fleetValue), fleet: null };
  }

  const fields = new Map();
  for (const [key, value] of Object.entries(fleetValue)) {
    if (key !== 'deliveries') fields.set(key, serialized(value));
  }
  return {
    state,
    top,
    fleetValue,
    fleetString: serialized(fleetValue),
    fleet: { fields, deliveries: deliveryIndex(fleetValue.deliveries) },
  };
}

const sameOrder = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);

function buildPatch(previous, current, boot, baseRevision, revision) {
  const changes = Object.create(null);
  const removed = [];
  for (const key of previous.top.keys()) {
    if (!current.top.has(key)) removed.push(key);
  }
  for (const [key, valueString] of current.top) {
    if (previous.top.get(key) !== valueString) changes[key] = current.state[key];
  }

  const patch = { type: 'state_patch', boot, baseRevision, revision, changes, removed };
  if (previous.fleetString === current.fleetString) return patch;
  if (!previous.fleet || !current.fleet || !previous.fleet.deliveries || !current.fleet.deliveries) return null;

  const fleet = Object.create(null);
  const fleetRemoved = [];
  for (const key of previous.fleet.fields.keys()) {
    if (!current.fleet.fields.has(key)) fleetRemoved.push(key);
  }
  for (const [key, valueString] of current.fleet.fields) {
    if (previous.fleet.fields.get(key) !== valueString) fleet[key] = current.fleetValue[key];
  }
  if (Object.keys(fleet).length) patch.fleet = fleet;
  if (fleetRemoved.length) patch.fleetRemoved = fleetRemoved;

  const upsert = [];
  const remove = [];
  for (const id of previous.fleet.deliveries.records.keys()) {
    if (!current.fleet.deliveries.records.has(id)) remove.push(id);
  }
  for (const [id, record] of current.fleet.deliveries.records) {
    if (previous.fleet.deliveries.strings.get(id) !== current.fleet.deliveries.strings.get(id)) upsert.push(record);
  }
  if (upsert.length || remove.length || !sameOrder(previous.fleet.deliveries.order, current.fleet.deliveries.order)) {
    patch.deliveries = { upsert, remove };
    if (!sameOrder(previous.fleet.deliveries.order, current.fleet.deliveries.order)) {
      patch.deliveries.order = current.fleet.deliveries.order;
    }
  }
  return patch;
}

function createStateFrames(boot) {
  if (typeof boot !== 'string' || !boot) throw new TypeError('boot must be a non-empty string');
  let revision = 0;
  let previous = null;
  let latest = null;

  return {
    publish(state) {
      if (!plainObject(state)) throw new TypeError('state must be an object');
      const nextRevision = revision + 1;
      const full = JSON.stringify({ type: 'state', boot, revision: nextRevision, state });
      const wireState = JSON.parse(full).state;
      const current = comparable(wireState);
      let patch = null;
      if (previous) {
        const delta = buildPatch(previous, current, boot, revision, nextRevision);
        if (delta) {
          const wirePatch = JSON.stringify(delta);
          if (Buffer.byteLength(wirePatch) < Buffer.byteLength(full)) patch = wirePatch;
        }
      }
      revision = nextRevision;
      previous = current;
      latest = Object.freeze({ revision, baseRevision: revision - 1, full, patch });
      return latest;
    },
    get latest() {
      return latest;
    },
  };
}

module.exports = { createStateFrames };
