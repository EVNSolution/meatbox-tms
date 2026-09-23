import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiResponseError, StaleSessionError, clearSessionData, createSessionGate, isTerminalSessionError } from './session-state.mjs';

test('only explicit session errors close the session boundary', () => {
  assert.equal(isTerminalSessionError(new ApiResponseError(401, 'session_required')), true);
  assert.equal(isTerminalSessionError(new ApiResponseError(410, 'session_expired')), true);
  assert.equal(isTerminalSessionError(new ApiResponseError(410, 'delivery_expired')), false);
  assert.equal(isTerminalSessionError(new ApiResponseError(410, 'exchange_retry_expired')), false);
  assert.equal(isTerminalSessionError(new ApiResponseError(401, 'installation_required')), false);
  assert.equal(isTerminalSessionError(new ApiResponseError(409, 'fid_version_conflict')), false);
});

test('a response from a closed or replaced generation cannot revive UI state', () => {
  const gate = createSessionGate();
  const first = gate.begin();
  gate.assert(first);
  gate.close();
  assert.throws(() => gate.assert(first), StaleSessionError);
  const next = gate.begin();
  assert.throws(() => gate.assert(first), StaleSessionError);
  gate.assert(next);
});

test('terminal session cleanup removes stale delivery, auth, timers, and FID UI state', () => {
  const state = { csrfToken:'secret', deliveryIds:['d1'], deliveryId:'d1', delivery:{ id:'d1' }, subscription:{ active:true },
    providerReady:true, notificationPhase:'registering', fidVersion:3, latestFidSync:Promise.resolve(), fidSyncError:new Error(), pollingTimer:1, countdown:2 };
  clearSessionData(state);
  assert.deepEqual({ ...state, latestFidSync:null, fidSyncError:null }, {
    csrfToken:'', deliveryIds:[], deliveryId:'', delivery:null, subscription:null,
    providerReady:false, notificationPhase:'', fidVersion:null, latestFidSync:null, fidSyncError:null,
    pollingTimer:null, countdown:null,
  });
});

test('one expired delivery does not close a valid multi-order session', () => {
  const gate = createSessionGate();
  const generation = gate.begin();
  const deliveryIds = ['expired-order', 'valid-order'];
  const error = new ApiResponseError(410, 'delivery_expired');
  if (isTerminalSessionError(error)) gate.close();
  gate.assert(generation);
  assert.deepEqual(deliveryIds, ['expired-order', 'valid-order']);
});
