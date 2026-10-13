import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { googleServicesPath, validateGoogleServices } = require('../../scripts/firebase-config.cjs') as {
  googleServicesPath(directory: string, explicitPath: string | undefined, packageName: string): string | undefined;
  validateGoogleServices(value: unknown, packageName: string): void;
};
const packageName = 'com.evnsolution.meatbox.driver';
const config = {
  project_info: { project_id: 'test-project', project_number: '123456' },
  client: [{ client_info: { mobilesdk_app_id: 'test-android-app', android_client_info: { package_name: packageName } }, api_key: [{ current_key: 'fixture-key' }] }],
};

test('Firebase build accepts only a complete matching Android client', () => {
  assert.doesNotThrow(() => validateGoogleServices(config, packageName));
  assert.throws(() => validateGoogleServices(config, 'another.app'));
  assert.throws(() => validateGoogleServices({ ...config, project_info: {} }, packageName));
});

test('service account keys cannot be mistaken for an Android app config', () => {
  assert.throws(() => validateGoogleServices({ type: 'service_account', private_key: 'fixture-only' }, packageName), /service account/u);
  assert.throws(() => validateGoogleServices({ ...config, private_key: 'fixture-only' }, packageName), /service account/u);
});

test('explicit missing Firebase config fails instead of silently producing a pushless APK', () => {
  const directory = mkdtempSync(join(tmpdir(), 'meatbox-firebase-config-'));
  try {
    assert.equal(googleServicesPath(directory, undefined, packageName), undefined);
    assert.throws(() => googleServicesPath(directory, './missing.json', packageName), /does not point/u);
    writeFileSync(join(directory, 'android.json'), JSON.stringify(config));
    assert.equal(googleServicesPath(directory, './android.json', packageName), join(directory, 'android.json'));
    writeFileSync(join(directory, 'invalid.json'), 'not-json');
    assert.throws(() => googleServicesPath(directory, './invalid.json', packageName), /not valid JSON/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
