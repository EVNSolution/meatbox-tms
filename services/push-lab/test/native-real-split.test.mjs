import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const template = (name) => readFileSync(new URL(`../../../deploy/push-lab/${name}`, import.meta.url), 'utf8');

test('native split keeps web loopback-only and Firebase credential worker-only', () => {
  const web = template('meatbox-push-lab-web.service.example');
  const worker = template('meatbox-push-lab-worker.service.example');
  const webEnv = template('native-web.env.example');
  const workerEnv = template('native-worker.env.example');
  const composeReal = template('compose.real-split.yaml.example');
  assert.match(web, /^User=meatbox-push-lab$/m);
  assert.match(worker, /^User=meatbox-push-worker$/m);
  assert.match(web, /^Group=meatbox-push-lab$/m);
  assert.match(worker, /^Group=meatbox-push-lab$/m);
  assert.match(web, /node server\/main\.mjs/);
  assert.match(worker, /node worker\/main\.mjs/);
  assert.match(web, /^IPAddressDeny=any$/m);
  assert.match(web, /^IPAddressAllow=localhost$/m);
  assert.doesNotMatch(worker, /^IPAddressDeny=any$/m);
  assert.match(worker, /^LoadCredential=firebase-service-account\.json:/m);
  assert.match(worker, /^PrivateMounts=true$/m);
  assert.match(worker, /^Environment=GOOGLE_APPLICATION_CREDENTIALS=%d\/firebase-service-account\.json$/m);
  assert.match(worker, /^ExecStartPre=\/usr\/bin\/test -w \/var\/lib\/meatbox-push-lab\/push-lab\.sqlite$/m);
  assert.doesNotMatch(web, /LoadCredential|GOOGLE_APPLICATION_CREDENTIALS/);
  assert.doesNotMatch(webEnv, /^GOOGLE_APPLICATION_CREDENTIALS=|^PUSH_LAB_REAL_FID_ALLOWLIST=/m);
  assert.match(workerEnv, /^PUSH_LAB_REAL_FID_ALLOWLIST=$/m);
  assert.match(webEnv, /^PUSH_LAB_SENDER_MODE=mock$/m);
  assert.match(workerEnv, /^PUSH_LAB_SENDER_MODE=real$/m);
  assert.match(composeReal, /push-lab-web:\n    environment:\n      PUSH_LAB_SENDER_MODE: real/);
  assert.match(composeReal, /push-lab-worker:\n    environment:\n      PUSH_LAB_SENDER_MODE: real/);
  for (const unit of [web, worker]) {
    assert.match(unit, /^ReadWritePaths=\/var\/lib\/meatbox-push-lab$/m);
    assert.match(unit, /^UMask=0007$/m);
    assert.match(unit, /^MemoryHigh=96M$/m);
    assert.match(unit, /^MemoryMax=128M$/m);
    assert.match(unit, /^CPUQuota=25%$/m);
    assert.match(unit, /^TimeoutStopSec=65s$/m);
    assert.doesNotMatch(unit, /^StateDirectory=/m);
  }
});
