const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));

const parseMessage = message => {
  if (typeof message === 'string') return JSON.parse(message);
  if (plainObject(message)) return message;
  throw new TypeError('state frame must be a JSON string or object');
};

const validRevision = value => Number.isSafeInteger(value) && value > 0;
const setOwn = (object, key, value) => Object.defineProperty(object, key, {
  value,
  enumerable: true,
  configurable: true,
  writable: true,
});

function validateFull(message) {
  if (typeof message.boot !== 'string' || !message.boot) throw new Error('Malformed full state boot');
  if (message.revision !== undefined && !validRevision(message.revision)) throw new Error('Malformed full state revision');
  if (!plainObject(message.state)) throw new Error('Malformed full state');
}

function validateKeys(values, label) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new Error(`Malformed ${label}`);
}

function deliveryMap(deliveries, label) {
  if (!Array.isArray(deliveries)) throw new Error(`Malformed ${label}`);
  const records = new Map();
  for (const record of deliveries) {
    if (!plainObject(record) || !own(record, 'id') || !validId(record.id) || records.has(record.id)) {
      throw new Error(`Malformed ${label}`);
    }
    records.set(record.id, record);
  }
  return records;
}

function applyDeliveries(current, delta) {
  if (!plainObject(delta) || !Array.isArray(delta.upsert) || !Array.isArray(delta.remove)) {
    throw new Error('Malformed deliveries patch');
  }
  const records = deliveryMap(current, 'current deliveries');
  const originalOrder = current.map(record => record.id);
  const originalIds = new Set(originalOrder);
  const upserts = deliveryMap(delta.upsert, 'delivery upserts');
  const removals = new Set();
  for (const id of delta.remove) {
    if (!validId(id) || removals.has(id)) throw new Error('Malformed delivery removals');
    removals.add(id);
  }
  for (const id of removals) records.delete(id);
  for (const [id, record] of upserts) records.set(id, record);

  if (own(delta, 'order')) {
    if (!Array.isArray(delta.order) || delta.order.length !== records.size) throw new Error('Malformed delivery order');
    const seen = new Set();
    const ordered = [];
    for (const id of delta.order) {
      if (!validId(id) || seen.has(id) || !records.has(id)) throw new Error('Malformed delivery order');
      seen.add(id);
      ordered.push(records.get(id));
    }
    return ordered;
  }

  if (delta.remove.length || [...upserts.keys()].some(id => !originalIds.has(id))) {
    throw new Error('Delivery membership change requires order');
  }
  return originalOrder.map(id => records.get(id));
}

export function createStateReceiver() {
  let boot = null;
  let revision = 0;
  let state = null;

  return {
    receive(input) {
      const message = parseMessage(input);
      if (message.type === 'state') {
        validateFull(message);
        boot = message.boot;
        revision = message.revision ?? 0;
        state = message.state;
        return state;
      }
      if (message.type !== 'state_patch') return null;
      if (!state) throw new Error('State patch has no base state');
      if (message.boot !== boot) throw new Error('State patch boot mismatch');
      if (!validRevision(message.baseRevision) || !validRevision(message.revision)
        || message.baseRevision !== revision || message.revision !== revision + 1) {
        throw new Error('State patch revision mismatch');
      }
      if (!plainObject(message.changes) || own(message.changes, 'fleet')) throw new Error('Malformed state changes');
      validateKeys(message.removed, 'state removals');
      if (message.removed.includes('fleet')) throw new Error('Malformed state removals');

      const next = { ...state };
      for (const key of message.removed) delete next[key];
      for (const [key, value] of Object.entries(message.changes)) setOwn(next, key, value);

      const hasFleetPatch = own(message, 'fleet') || own(message, 'fleetRemoved') || own(message, 'deliveries');
      if (hasFleetPatch) {
        if (!plainObject(state.fleet) || !Array.isArray(state.fleet.deliveries)) throw new Error('Fleet patch has no fleet base');
        const fleet = { ...state.fleet };
        if (own(message, 'fleet')) {
          if (!plainObject(message.fleet) || own(message.fleet, 'deliveries')) throw new Error('Malformed fleet changes');
          for (const [key, value] of Object.entries(message.fleet)) setOwn(fleet, key, value);
        }
        if (own(message, 'fleetRemoved')) {
          validateKeys(message.fleetRemoved, 'fleet removals');
          if (message.fleetRemoved.includes('deliveries')) throw new Error('Malformed fleet removals');
          for (const key of message.fleetRemoved) delete fleet[key];
        }
        if (own(message, 'deliveries')) fleet.deliveries = applyDeliveries(state.fleet.deliveries, message.deliveries);
        next.fleet = fleet;
      }

      boot = message.boot;
      revision = message.revision;
      state = next;
      return state;
    },
  };
}
