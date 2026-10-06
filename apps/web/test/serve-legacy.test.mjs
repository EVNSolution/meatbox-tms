import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

async function startup(t, { kotlin = false, auth = 'node', resources = 'node', dispatch = 'node' }) {
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, MEATBOX_LEGACY_GATEWAY_PORT: String(port), MEATBOX_LEGACY_PUBLIC_ORIGIN: origin,
    MEATBOX_LEGACY_API_ORIGIN: 'http://127.0.0.1:3001', MEATBOX_AUTH_OWNER: auth,
    MEATBOX_RESOURCES_OWNER: resources, MEATBOX_DISPATCH_OWNER: dispatch };
  if (kotlin) env.MEATBOX_KOTLIN_API_ORIGIN = 'http://127.0.0.1:8081';
  else delete env.MEATBOX_KOTLIN_API_ORIGIN;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/serve-legacy.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; });
  let output = '', error = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { error += chunk; });
  const selectedNode = !kotlin || [auth, resources, dispatch].includes('node');
  const finalLine = selectedNode ? `with PUBLIC_ORIGIN=${origin}\n` : 'Kotlin API origin: http://127.0.0.1:8081\n';
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Gateway startup did not finish: ${error}`)), 5000);
    t.after(() => clearTimeout(deadline));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.endsWith(finalLine)) { clearTimeout(deadline); resolve(); } });
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(deadline); reject(new Error(`Gateway exited ${code}: ${error}`)); });
  });
  return output;
}

test('native 게이트웨이는 Kotlin 소유권을 표시하며 중지된 Node API의 기동을 지시하지 않는다', async t => {
  const output = await startup(t, { kotlin: true, auth: 'kotlin', resources: 'kotlin', dispatch: 'kotlin' });
  assert.match(output, /Meatbox web gateway ready/);
  assert.match(output, /API owners: source=kotlin, auth=kotlin, resources=kotlin, dispatch=kotlin/);
  assert.match(output, /Kotlin API origin: http:\/\/127\.0\.0\.1:8081/);
  assert.doesNotMatch(output, /Start.*Node|legacy transition/);
});

test('Node 비교 모드는 선택된 Node 소유권과 API 기동 안내를 표시한다', async t => {
  const output = await startup(t, {});
  assert.match(output, /API owners: source=node, auth=node, resources=node, dispatch=node/);
  assert.match(output, /Start the selected Node API at http:\/\/127\.0\.0\.1:3001/);
  assert.doesNotMatch(output, /Kotlin API origin/);
});

test('혼합 비교 모드는 각 소유권을 표시하고 필요한 Node API만 안내한다', async t => {
  const output = await startup(t, { kotlin: true, auth: 'kotlin', dispatch: 'kotlin' });
  assert.match(output, /API owners: source=kotlin, auth=kotlin, resources=node, dispatch=kotlin/);
  assert.match(output, /Kotlin API origin: http:\/\/127\.0\.0\.1:8081/);
  assert.match(output, /Start the selected Node API/);
});
