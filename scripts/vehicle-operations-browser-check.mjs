import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createDemo } from '../server.js';

// Uses an existing Playwright installation; no browser or npm dependency is installed.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.runtime/vehicle-redesign-qa');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-vehicle-browser-'));
const origin = `http://127.0.0.1:${process.env.BROWSER_CHECK_PORT || 3055}`;
let demo = createDemo({ accessFile: path.join(temporary, 'access.json'), origin });
const checks = [], errors = [], measurements = {};
let browser, page;
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); };
await fs.mkdir(output, { recursive: true });
try {
  const invite = await demo.access.issueInvite();
  await demo.access.register({ username: 'vehicle-review', password: 'local-review-only', invite });
  await new Promise(resolve => demo.server.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
  check('Anonymous operator access requires login', (await fetch(origin + '/combined/', { redirect: 'manual' })).status === 302);
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1060 }, deviceScaleFactor: 1 });
  const makePage = async () => { const tab = await context.newPage(); tab.setDefaultTimeout(8000); tab.on('pageerror', error => errors.push(error.message)); return tab; };
  page = await makePage();
  await page.goto(origin + '/login');
  await page.locator('[name=username]').fill('vehicle-review');
  await page.locator('[name=password]').fill('local-review-only');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await page.waitForURL('**/combined/**');
  const openOperator = async (view, id = 'S1') => {
    await page.goto(`${origin}/combined/?id=${id}#/${view}`);
    await page.locator('#live-pages').waitFor({ state: 'visible' });
  };
  const screenshot = async (name, tab = page) => { await tab.screenshot({ path: path.join(output, name + '.png'), fullPage: true }); };
  const matches = async (selector, re, tab = page) => {
    await tab.waitForFunction(({ selector, source, flags }) => new RegExp(source, flags).test(document.querySelector(selector)?.textContent || ''), { selector, source: re.source, flags: re.flags });
  };
  const noOverflow = async (tab = page) => tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

  await openOperator('orders');
  assert.deepEqual(await page.locator('[data-page-link]').allTextContents(), ['배차 관리', '배송 관제', '자원 관리']);
  check('Operator menu names and order');
  await page.waitForFunction(() => document.querySelectorAll('#order-planning [data-order-marker]').length === 8);
  await page.waitForTimeout(4500); // Allow external OFM basemap tiles to finish for visual evidence.
  check('Dispatch headings omit redundant red counters', await page.locator('.order-vehicle-heading [data-order-vehicle-count], .order-map-heading [data-order-map-count]').count() === 0);
  check('Location counts start in a collapsed disclosure', await page.locator('.order-location-info').getAttribute('open') === null);
  const markerSnapshot = await page.locator('#order-planning [data-order-marker]').evaluateAll(nodes => nodes.map(node => { node.dataset.qaIdentity = node.dataset.orderMarker; return [node.dataset.orderMarker, node.style.transform]; }));
  await page.locator('[data-order-vehicle-id="V2"]').click();
  assert.deepEqual(await page.locator('#order-planning [data-order-marker]').evaluateAll(nodes => nodes.map(node => [node.dataset.qaIdentity, node.style.transform])), markerSnapshot);
  check('Vehicle switch preserves every order marker identity and coordinate projection');
  check('No vehicle marker on dispatch map', await page.locator('.order-map-vehicle').count() === 0);
  await matches('[data-order-map-count]', /전체 위치 미등록 4,515곳.*선택 차량 미등록 35곳/);
  await page.locator('.order-location-info > summary').click();
  check('Location registration counts remain available below the map', await page.locator('[data-order-map-count]').isVisible());
  await screenshot('dispatch-location-information');
  await page.locator('.order-location-info > summary').click();
  await page.locator('[data-order-vehicle-id="V1"]').click();
  check('All selected-vehicle order markers foregrounded', await page.locator('#order-planning [data-selected-vehicle="true"]').count() === 8);
  const original = JSON.stringify(demo.sim.snapshot());
  await page.locator('[data-order-scenario-open]').click();
  await matches('[data-order-total-vehicles]', /130대/);
  await matches('[data-order-total-destinations]', /4,523곳/);
  await page.locator('[data-order-volume-number]').fill('80');
  await page.locator('[data-order-volume-number]').blur();
  await matches('[data-order-target]', /7,272박스/);
  await page.locator('[data-order-volume-number]').fill('120');
  await page.locator('[data-order-volume-number]').blur();
  await matches('[data-order-target]', /10,908박스/);
  check('80–120 percent preview does not change any server state', original === JSON.stringify(demo.sim.snapshot()));
  await screenshot('order-scenario');
  await page.locator('[data-order-scenario-close]').click();
  check('Scenario reset button is removed', await page.locator('[data-order-volume-reset]').count() === 0);
  await screenshot('dispatch-desktop');
  check('Region controls are explanatory only', await page.getByRole('button', {name:/권역 편집|핀배차/}).count() === 0);
  const canvas = page.locator('[data-order-map-layer]');
  const beforeWheel = await page.locator('#order-planning [data-order-marker]').evaluateAll(nodes => nodes.map(node => node.style.transform));
  await canvas.hover(); await page.mouse.wheel(0, 180);
  check('Ordinary map wheel displays modifier guidance', await page.locator('#order-planning .maplibregl-cooperative-gesture-screen').count() === 1);
  await page.waitForTimeout(200);
  assert.deepEqual(await page.locator('#order-planning [data-order-marker]').evaluateAll(nodes => nodes.map(node => node.style.transform)), beforeWheel);
  check('Ordinary wheel preserves map zoom');
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -240);
  await page.keyboard.up('Control');
  await page.waitForTimeout(1000);
  check('Control-wheel changes map zoom', JSON.stringify(await page.locator('#order-planning [data-order-marker]').evaluateAll(nodes => nodes.map(node => node.style.transform))) !== JSON.stringify(beforeWheel));
  check('Attribution starts collapsed', await page.locator('#order-planning .maplibregl-compact-show').count() === 0);

  demo.sim.setScenario('arrived', 'S1');
  await openOperator('control');
  await matches('[data-control-summary]', /문정갈비/);
  check('All four workload sort options exist', await page.locator('[data-control-sort] option').count() === 4);
  await page.locator('[data-control-sort]').selectOption('boxes');
  check('Remaining-box sort responds', await page.locator('[data-control-vehicle]').first().getAttribute('data-control-vehicle') === 'V2');
  await page.locator('[data-control-sort]').selectOption('received');
  const summary = await page.locator('[data-control-summary]').innerText();
  await page.locator('[data-control-stop="S5"] > summary').click();
  await page.locator('[data-control-stop="S5"] .control-stop-body').waitFor();
  check('Inspecting another stop preserves current vehicle summary', summary === await page.locator('[data-control-summary]').innerText());
  await page.locator('[data-control-support]').click();
  await matches('[data-support-data]', /기준 미정/);
  check('Unsupported calling remains disabled', await page.getByRole('button', {name:'호출 대기'}).isDisabled());
  await screenshot('support-waiting');
  await page.locator('[data-support-close]').click();
  await page.locator('[data-control-vehicle="V2"]').click();
  await matches('[data-control-map-note]', /위치 미등록 35곳/);
  check('Synthetic vehicle cannot show a live vehicle marker', await page.locator('.control-map-vehicle').count() === 0);
  await page.locator('#tab-management').click();
  await page.locator('[data-control-route]').click();
  check('Synthetic route editor disabled', await page.locator('[data-route-action="edit"]').isDisabled());
  await page.locator('[data-control-vehicle="V1"]').click();
  await page.locator('[data-control-route]').click();
  const originalOrder = demo.sim.snapshot().order.map(stop => stop.id);
  check('Route management enters editing immediately', await page.locator('[data-route-action="save"]').isVisible());
  check('Current stop protected from route movement', await page.locator('[data-handle="S1"]').isDisabled());
  await page.locator('[data-move="S2"][data-direction="1"]').click();
  await page.locator('[data-route-action="cancel"]').click();
  assert.deepEqual(demo.sim.snapshot().order.map(stop => stop.id), originalOrder);
  check('Route draft cancellation preserves server order');
  await page.locator('[data-control-route]').click();
  await page.locator('[data-move="S2"][data-direction="1"]').click();
  demo.sim.setScenario('completed', 'S1');
  await page.waitForFunction(() => !document.querySelector('[data-route-action="save"]') || document.querySelector('[data-route-action="save"]').disabled);
  check('Route update invalidates stale draft', await page.locator('[data-route-action="save"]').count() === 0 || await page.locator('[data-route-action="save"]').isDisabled());
  await page.locator('#tab-monitor').click();
  await page.waitForTimeout(1600);
  await screenshot('control-desktop');

  // Keep customer and operator open against the same isolated, authenticated server.
  const customer = await makePage();
  await customer.goto(origin + '/combined/mobile-customer.html?id=S1');
  await matches('#account-name', /문정갈비/, customer);
  demo.sim.sendCustomerNotice('S1', '첫 번째 배송지 대상 확인', '로컬 검증');
  await matches('#customer-push-body', /첫 번째 배송지 대상 확인/, customer);
  check('Matching new customer notice opens the popup');
  await customer.locator('#customer-push-close').click();
  demo.sim.sendCustomerNotice('S2', '다른 배송지 비공개 확인', '로컬 검증');
  await page.locator('[data-control-stop="S2"] > summary').click();
  check('Destination disclosure omits history and notices', await page.locator('[data-control-stop="S2"] .control-fact-list, [data-control-stop="S2"] .control-notices').count() === 0);
  await page.locator('[data-control-manage="S2"]').click();
  check('Record action opens management for the exact stop', await page.locator('#tab-management').getAttribute('aria-selected') === 'true' && await page.locator('[data-control-record-stop]').inputValue() === 'S2');
  await page.locator('[data-control-record-filter="notice"]').click();
  await page.locator('[data-control-records] details').last().locator('summary').click();
  await matches('[data-control-records]', /다른 배송지 비공개 확인/);
  check('Notice filter excludes history', await page.locator('[data-control-records] [data-record-kind="history"]').count() === 0);
  check('Customer notices do not cross destination identity', !(await customer.locator('#customer-notification-list').innerText()).includes('다른 배송지 비공개 확인'));
  await customer.locator('#notification-bell').click();
  await customer.locator('#notifications-read-all').click();
  check('Read-all clears unread flags', await customer.locator('[data-unread="true"]').count() === 0);
  await customer.locator('#notifications-clear').click();
  check('Customer notification deletion works', await customer.locator('#notifications-empty').isVisible());
  await customer.locator('#notifications-close').click();
  await customer.locator('#switch-account').click();
  await customer.locator('#account-search').fill('송파한우촌');
  await customer.locator('[data-acct="S2"]').click();
  await matches('#account-name', /송파한우촌/, customer);
  check('Customer store selection works');
  await customer.waitForTimeout(1500);
  check('Customer house marker preserved', await customer.locator('.customer-map-house').count() === 1);
  await screenshot('customer-desktop', customer);

  await openOperator('deliveries', 'S1');
  for (const tab of ['drivers', 'vehicles', 'destinations']) {
    await page.locator(`[data-resource-tab="${tab}"]`).click();
    await screenshot('resource-' + tab);
  }
  await page.locator('[data-resource-tab="drivers"]').click();
  await page.locator('[data-resource-search="drivers"]').fill('예시 배송원 002');
  await page.locator('[data-resource-list="drivers"] [data-resource-select="V2"]').click();
  await matches('[data-resource-detail="drivers"]', /메인 권역[\s\S]*미등록/);
  await page.locator('[data-resource-detail="drivers"] [data-resource-assignments]').click();
  await matches('#delivery-count', /35 \/ 4523건/);
  check('Driver assignment links target the exact vehicle');
  demo.sim.setDeliveryTip('V2-S1', '자원 연결 검증 팁');
  await page.locator('[data-select="V2-S1"]').click();
  await matches('#delivery-selection', /자원 연결 검증 팁/);
  check('Resource destination tips match their ID');

  demo.sim.setScenario('arrived', 'S1');
  const driver = await makePage();
  await driver.goto(origin + '/combined/driver.html?id=S1');
  await driver.locator('#driver-workspace').waitFor({state:'visible'});
  await driver.locator('[data-action="complete"]:visible').click();
  check('Photo is required before request confirmation', await driver.locator('[data-proof-next]').isDisabled());
  await screenshot('driver-camera-empty', driver);
  check('No separate example photo action remains', await driver.locator('[data-photo="example"]').count() === 0);
  await driver.locator('[data-photo="camera"]').click();
  await driver.waitForFunction(() => { const photo = document.querySelector('#dv-proof-preview img'); return photo?.complete && photo.naturalWidth > 0; });
  check('Provided example photo loads in the evidence preview', /delivery-proof-example\.jpg$/.test(await driver.locator('#dv-proof-preview img').getAttribute('src')));
  check('Example selection alone does not complete the stop', demo.sim.snapshot().order.find(stop => stop.id === 'S1').status === 'current');
  await screenshot('driver-camera-example', driver);
  await driver.locator('[data-proof-next]').click();
  check('Confirmation retains the selected photograph', /delivery-proof-example\.jpg$/.test(await driver.locator('.dv-proof-thumb img').getAttribute('src')));
  check('Photo alone cannot bypass required customer requests', await driver.locator('[data-proof-confirm]').isDisabled());
  await driver.locator('[data-request-check="S1-refrigerator"]').check();
  check('Photo and all required requests enable final confirmation', await driver.locator('[data-proof-confirm]').isEnabled());
  await screenshot('driver-confirmation', driver);
  await driver.locator('[data-proof-confirm]').click();
  await matches('#driver-done', /1\/8|1/ , driver);
  check('Confirmation records completion only after server response', demo.sim.snapshot().order.find(stop => stop.id === 'S1').status === 'done');
  await openOperator('control', 'S1');
  await matches('[data-control-summary]', /7곳[\s\S]*52박스/);
  check('Remaining workload updates after completion');
  await driver.locator('[data-group="history"]').click();
  await driver.locator('#dv-history-date').fill('2026-09-14');
  await driver.locator('#dv-history-date').dispatchEvent('change');
  check('Dated demo history is separate from current route', await driver.locator('.dv-history-card').count() === 2);
  check('History labels and values retain readable spacing', await driver.locator('.dv-history-card .dv-key-values > div').evaluateAll(nodes => nodes.every(node => node.querySelector('dd').getBoundingClientRect().left - node.querySelector('dt').getBoundingClientRect().right >= 7)));
  await screenshot('driver-history', driver);
  await driver.locator('#dv-history-date').fill('2026-09-13');
  await driver.locator('#dv-history-date').dispatchEvent('change');
  await matches('#dv-history', /선택한 날짜의 예시 기록이 없습니다/, driver);
  await driver.locator('[data-group="today"]').click();
  await driver.locator('#dv-tab-map').click();
  await driver.waitForTimeout(1500);
  await screenshot('driver-map', driver);
  await driver.locator('.dv-map-pin').first().waitFor({state:'visible'});
  assert.deepEqual(await driver.locator('.dv-map-pin').first().evaluate(node => { const style = getComputedStyle(node); return [parseFloat(style.width), parseFloat(style.height)]; }), [22,26]);
  check('Driver marker visual size remains 22 by 26 pixels');
  for (const [name, tab] of [['driver',driver],['customer',customer]]) {
    check(`${name} viewer has no operator sidebar`, await tab.locator('#demo-navigation').count() === 0);
    const frame = await tab.locator('.app-viewer-device').first().boundingBox();
    check(`${name} phone frame remains 390 by 780 pixels`, frame.width === 390 && frame.height === 780);
    const aligned = await tab.locator('.dv-icon:visible, .icon-button:visible').evaluateAll(nodes => nodes.filter(node => node.querySelector('svg')).every(node => {
      const button = node.getBoundingClientRect(), svg = node.querySelector('svg').getBoundingClientRect();
      return Math.abs(button.x + button.width / 2 - svg.x - svg.width / 2) <= 1 && Math.abs(button.y + button.height / 2 - svg.y - svg.height / 2) <= 1;
    }));
    check(`${name} SVG icons align to the centers of icon buttons`, aligned);
  }

  // Narrow screens retain internal scrolling rather than document overflow.
  for (const width of [390, 320]) {
    await page.setViewportSize({width,height:844});
    for (const view of ['orders','control','deliveries']) {
      await openOperator(view);
      check(`${view} has no document overflow at ${width}px`, await noOverflow());
      await screenshot(`${view}-${width}`);
    }
  }
  await driver.setViewportSize({width:390,height:844});
  await driver.locator('#dv-tab-delivery').click();
  check('Driver narrow layout has no document overflow', await noOverflow(driver));
  await screenshot('driver-390', driver);
  await customer.setViewportSize({width:390,height:844});
  check('Customer narrow layout has no document overflow', await noOverflow(customer));
  await screenshot('customer-390', customer);
  check('Both phone clocks are preserved', (await driver.locator('#driver-clock').innerText()) !== '--:--' && (await customer.locator('#customer-clock').innerText()) !== '--:--');

  demo.sim.setScenario('arrived', 'S2');
  await driver.locator('[data-action="complete"]:visible').click();
  await driver.locator('#dv-proof-file').setInputFiles(path.join(root, 'apps/combined/assets/delivery-proof-example.jpg'));
  // Browser offline emulation does not reliably close existing WebSockets.
  // Stop only this disposable server to exercise a real connection loss.
  await demo.close();
  await driver.locator('#dv-sheet-layer').waitFor({state:'hidden'});
  await matches('#dv-feedback', /사진을 새로 촬영|다시 연결한 뒤/, driver);
  // Sessions are in memory; retain the test access service while replacing the
  // transport so this checks reconnection rather than a new-login flow.
  demo = createDemo({access:demo.access,origin});
  demo.sim.setScenario('arrived', 'S2');
  await new Promise(resolve => demo.server.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
  await driver.locator('#driver-connection').waitFor({state:'hidden',timeout:40000});
  await driver.locator('#driver-workspace').waitFor({state:'visible'});
  await driver.locator('[data-action="complete"]:visible').click({timeout:15000});
  check('Reconnected completion requires a fresh photo', await driver.locator('[data-proof-next]').isDisabled());
  await driver.locator('#dv-sheet-close').click();
  check('Disconnection discards the photo and prevents reuse after reconnect');

  // Isolated large coordinate fixture: DOM rendering and foreground selection, not production geography.
  await page.setViewportSize({width:1600,height:1060});
  const routeResponse = await page.request.get(origin + '/scenario/api/route-data');
  const route = await routeResponse.json();
  const synthetic = demo.sim.snapshot().fleet.deliveries.map((stop, index) => ({id:stop.id, lng:126.88 + (index % 75) * .003, lat:37.3 + Math.floor(index / 75) * .003}));
  await page.route('**/scenario/api/route-data', handler => handler.fulfill({json:{...route,points:[...route.points,...synthetic]}}));
  const start = performance.now();
  await openOperator('orders');
  // Hash navigation preserves the live map's cached coordinates. Reload only this
  // isolated fixture page so its new mocked route-data response is actually read.
  await page.reload();
  await page.locator('#live-pages').waitFor({state:'visible'});
  await page.waitForFunction(() => document.querySelectorAll('#order-planning [data-order-marker]').length === 4523, null, {timeout:20000});
  measurements.fullMarkerMountMs = +(performance.now() - start).toFixed(1);
  const selectStart = performance.now();
  await page.locator('[data-order-vehicle-id="V2"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#order-planning [data-selected-vehicle="true"]').length === 35);
  measurements.vehicleHighlightMs = +(performance.now() - selectStart).toFixed(1);
  check('4,523 isolated markers survive vehicle selection', await page.locator('#order-planning [data-order-marker]').count() === 4523);
  check('No browser JavaScript errors', errors.length === 0);
  await fs.writeFile(path.join(output, 'browser-results.json'), JSON.stringify({checks, measurements, errors, scope:'Isolated localhost demo. Synthetic coordinate fixture, local image input and dated example history. No deployment, physical camera, actual GPS or persistent photo evidence.'},null,2));
  console.log(JSON.stringify({passed:checks.length,measurements,errors},null,2));
} catch (error) {
  await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});
  await fs.writeFile(path.join(output,'browser-failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));
  throw error;
} finally {
  await browser?.close(); await demo.close(); await fs.rm(temporary,{recursive:true,force:true});
}
