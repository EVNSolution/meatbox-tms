import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This check retains historical Git blobs and verifies only maintained files.
// The standalone apps/web build and tests must not depend on this check.
const root = fileURLToPath(new URL('../', import.meta.url));
const sourceRevision = 'c1f29a6';
const sourceCommit = 'c1f29a657678b51af888d6be2574103d89c1562f';
const sourceRoots = ['apps/combined', 'apps/portal', 'workspaces/jiin-ui', 'workspaces/sanghyun-scenario/public'];
const legacyTests = new Set([
  'customer-demo-route.test.mjs', 'delivery-review.test.mjs', 'driver-map-model.test.mjs',
  'simulation-adapter.test.mjs', 'vehicle-operations-model.test.mjs',
]);
const cssFragments = new Map([
  ['apps/combined/styles.css', [
    ['foundation', 1, 56], ['shell', 57, 344], ['workspace', 345, 948],
    ['preview', 949, 1179], ['controls', 1180, 1305], ['responsive', 1306, 1449],
    ['live', 1450, 1525], ['responsive-small', 1526, 1573], ['composition', 1574, 1843],
  ]],
  ['workspaces/jiin-ui/styles.css', [
    ['foundation', 1, 55], ['shell', 56, 345], ['workspace', 346, 967],
    ['preview', 968, 1200], ['controls', 1201, 1332], ['responsive', 1333, 1540],
    ['composition', 1541, 1782],
  ]],
]);
const authoredPaths = [
  'apps/web/.gitignore', 'apps/web/.oxlintrc.json', 'apps/web/README.md',
  'apps/web/package-lock.json', 'apps/web/package.json', 'apps/web/public/theme.css',
  'apps/web/public/components.css', 'apps/web/combined/status-notification.css',
  'apps/web/scripts/api-routing.mjs', 'apps/web/combined/operations-adapter.test.mjs',
  'apps/web/test/serve-legacy.test.mjs',
  'apps/web/scripts/legacy-gateway.mjs', 'apps/web/scripts/serve-legacy.mjs',
  'apps/web/scripts/test.mjs', 'apps/web/src/auth-contract.ts', 'apps/web/src/auth.ts',
  'apps/web/src/shared/maps/order-map.test.mjs', 'apps/web/test/auth-contract.test.mjs',
  'apps/web/src/shared/ui/status-notification.mjs', 'apps/web/src/shared/ui/status-notification.test.mjs',
  'apps/web/test/api-routing.test.mjs',
  'apps/web/test/fork-artifact.check.mjs', 'apps/web/test/legacy-gateway.test.mjs',
  'apps/web/tsconfig.json', 'apps/web/vite.config.mjs',
  'apps/web/combined/bulk-selection.mjs', 'apps/web/combined/bulk-selection.test.mjs',
  'apps/web/combined/zone-volume.mjs', 'apps/web/combined/zone-volume.test.mjs',
  'apps/web/combined/vehicle-identity.mjs', 'apps/web/combined/vehicle-identity.test.mjs',
].sort();
const inventory = JSON.parse(readFileSync(path.join(root, 'apps/web/fork-inventory.json'), 'utf8'));
const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = git(['ls-tree', '-r', '--name-only', sourceCommit, '--', ...sourceRoots])
  .toString('utf8').trim().split('\n');
const sourceBytes = new Map();
function baseline(source) {
  if (!sourceBytes.has(source)) sourceBytes.set(source, git(['show', `${sourceCommit}:${source}`]));
  return sourceBytes.get(source);
}

function originalLines(source, first, last) {
  return baseline(source).toString('utf8').split('\n').slice(first - 1, last).join('\n') + '\n';
}

function expectedSharedMap() {
  const original = baseline('apps/combined/order-planning.mjs').toString('utf8');
  const formatter = original.match(/^const boxesText = .*;$/m)[0];
  const model = original.slice(original.indexOf('export function orderMapModel('), original.indexOf('export function regionOrderCounts(')).trimEnd();
  const factories = original.slice(original.indexOf('export function createOrderMap('), original.indexOf('export function mountOrderPlanning(')).trimEnd()
    .replace("new URL('./assets/vendor/maplibre/maplibre-gl-csp-worker.js', import.meta.url).href", "'/combined/assets/vendor/maplibre/maplibre-gl-csp-worker.js'")
    .replace("new URL('./assets/maps/dsv-korea-v1.json', import.meta.url).href", "'/combined/assets/maps/dsv-korea-v1.json'");
  return [formatter, model, factories].join('\n\n') + '\n\n';
}

function expectedTargets(source) {
  if (cssFragments.has(source)) {
    const directory = source.startsWith('apps/combined/') ? 'apps/web/combined' : 'apps/web/ui-layout';
    const targets = [directory + '/styles.css', ...cssFragments.get(source).map(([name]) => `${directory}/styles/${name}.css`)];
    if (source === 'apps/combined/styles.css') targets.push('apps/web/combined/date-summary-toolbar.css');
    return targets;
  }
  if (source === 'apps/combined/order-planning.mjs') return ['apps/web/combined/order-planning.mjs', 'apps/web/src/shared/maps/order-map.mjs'];
  if (source.startsWith('apps/combined/assets/')) {
    const targets = ['apps/web/public/combined/assets/' + source.slice('apps/combined/assets/'.length)];
    if (source.endsWith('/PretendardVariable.ttf')) targets.push('apps/web/public/portal-font.ttf');
    if (source.endsWith('/meatbox-logo.svg')) targets.push('apps/web/public/portal-logo.svg');
    return targets;
  }
  const renamed = { 'simulation-adapter.mjs': 'operations-adapter.mjs', 'simulation-client.mjs': 'operations-client.mjs', 'simulation-client.test.mjs': 'operations-client.test.mjs' };
  if (source.startsWith('apps/combined/') && renamed[source.slice('apps/combined/'.length)]) {
    return ['apps/web/combined/' + source.slice('apps/combined/'.length), 'apps/web/combined/' + renamed[source.slice('apps/combined/'.length)]];
  }
  if (source.startsWith('apps/combined/')) {
    const name = source.slice('apps/combined/'.length);
    return [legacyTests.has(name) ? 'test/web-fork-legacy/' + name : 'apps/web/combined/' + name];
  }
  if (source.startsWith('apps/portal/')) {
    const name = source.slice('apps/portal/'.length);
    if (name === 'pages.js') return ['apps/web/login/index.html', 'apps/web/dev/register/index.html'];
    return ['apps/web/public/' + (name === 'validation.js' ? 'portal-validation.js' : name)];
  }
  if (source.startsWith('workspaces/jiin-ui/')) return ['apps/web/ui-layout/' + source.slice('workspaces/jiin-ui/'.length)];
  const name = source.slice('workspaces/sanghyun-scenario/public/'.length);
  return [name.endsWith('.html') ? 'apps/web/scenario/' + (name === 'index.html' ? 'reference.html' : name) : 'apps/web/public/scenario/' + name];
}

test('frontend fork accounts for every fixed-baseline source and all transformed targets', () => {
  assert.equal(inventory.schemaVersion, 3);
  assert.equal(inventory.sourceRevision, sourceRevision);
  assert.equal(inventory.sourceCommit, sourceCommit);
  assert.equal(git(['rev-parse', `${sourceRevision}^{commit}`]).toString('utf8').trim(), sourceCommit);
  assert.deepEqual(inventory.sourceRoots, sourceRoots);
  assert.deepEqual(sourceRoots.map(prefix => sourceFiles.filter(source => source.startsWith(prefix + '/')).length), [114, 4, 13, 11]);
  assert.equal(inventory.sourceFileCount, 142);
  assert.equal(inventory.initialForkTargetFileCount, 145);
  assert.equal(inventory.historicalTargetFileCount, 163);
  assert.equal(inventory.targetFileCount, inventory.records.filter(record => record.status === 'active').length);
  assert.equal(inventory.additionalDerivedTargetFileCount, 3);
  assert.equal(inventory.records.length, 163 + inventory.additionalDerivedTargetFileCount);
  assert.deepEqual([...new Set(inventory.records.map(record => record.source))].sort(), sourceFiles);

  const pairs = inventory.records.map(record => `${record.source} -> ${record.target}`);
  const expectedPairs = sourceFiles.flatMap(source => expectedTargets(source).map(target => `${source} -> ${target}`));
  assert.equal(new Set(pairs).size, pairs.length, 'duplicate source-to-target mapping');
  assert.equal(new Set(inventory.records.map(record => record.target)).size, inventory.records.length, 'each target has one provenance source');
  assert.deepEqual(pairs.sort(), expectedPairs.sort());
  for (const record of inventory.records) {
    assert.doesNotMatch(record.target, /(?:^|\/)(?:\.runtime|node_modules|dist|build)(?:\/|$)/);
    assert.equal(path.posix.normalize(record.target), record.target, record.target);
    assert.ok(record.reason?.trim(), `${record.target}: missing fork reason`);
    assert.ok(Array.isArray(record.changes), `${record.target}: missing transformation list`);
    if (record.sourceSha256 !== record.targetSha256) {
      assert.ok(record.changes.length && record.changes.every(change => typeof change === 'string' && change.trim()), `${record.target}: unexplained transformation`);
    }
  }
});

test('CSS fragments retain fixed original ranges and extraction evidence without needing ignored artifacts', () => {
  for (const [source, fragments] of cssFragments) {
    const directory = source.startsWith('apps/combined/') ? 'apps/web/combined' : 'apps/web/ui-layout';
    const pieces = fragments.map(([name, firstOriginalLine, lastOriginalLine]) => {
      const record = inventory.records.find(item => item.target === `${directory}/styles/${name}.css`);
      assert.ok(record, `${source}: missing derived ${name} fragment`);
      assert.deepEqual(record.derivation, {
        kind: 'css-line-range', firstOriginalLine, lastOriginalLine,
        extractedSha256: hash(originalLines(source, firstOriginalLine, lastOriginalLine)),
        evidence: 'apps/web/.runtime/design-proof/css-split-proof.json',
      });
      return originalLines(source, firstOriginalLine, lastOriginalLine);
    });
    assert.equal(hash(pieces.join('')), hash(baseline(source)), `${source}: extraction ranges must account for the entire original cascade`);
    const entry = readFileSync(path.join(root, directory, 'styles.css'), 'utf8');
    assert.deepEqual([...entry.matchAll(/@import\s+["']\.\/styles\/([^"']+)\.css["']/g)].map(match => match[1]), fragments.filter(([name]) => inventory.records.find(record => record.target === `${directory}/styles/${name}.css`).status === 'active').map(([name]) => name), `${source}: preserve active fragment import order`);
  }
  const toolbar = inventory.records.find(record => record.target === 'apps/web/combined/date-summary-toolbar.css');
  assert.deepEqual(toolbar.derivation, {
    kind: 'css-line-range', firstOriginalLine: 268, lastOriginalLine: 323,
    extractedSha256: hash(originalLines('apps/combined/styles.css', 268, 323)),
    evidence: 'apps/web/.runtime/design-proof/css-split-proof.json',
  });
  assert.equal(hash(readFileSync(path.join(root, toolbar.target))), toolbar.targetSha256, 'the shared toolbar retains the reviewed target hash alongside its original extraction');
  assert.ok(toolbar.changes.some(change => /center/i.test(change)), 'explain the intentional center alignment change');
});

test('shared map is an exact original-function extraction with the established fixed asset URLs', () => {
  const record = inventory.records.find(item => item.target === 'apps/web/src/shared/maps/order-map.mjs');
  const expected = expectedSharedMap();
  assert.equal(record.source, 'apps/combined/order-planning.mjs');
  assert.deepEqual(record.derivation, {
    kind: 'map-function-extraction',
    functions: ['boxesText', 'orderMapModel', 'createOrderMap', 'createOrderMarker'],
    extractedSha256: hash(expected),
    evidence: 'apps/web/.runtime/design-proof/map-extraction-proof.json',
  });
  assert.equal(readFileSync(path.join(root, record.target), 'utf8'), expected, 'shared map behavior must remain an exact extraction');
});

test('authored frontend files have their own provenance and current hashes', () => {
  assert.equal(inventory.authoredFileCount, authoredPaths.length);
  assert.equal(inventory.historicalAuthoredFileCount, 21);
  assert.deepEqual(inventory.authoredFiles.filter(file => file.status === 'active').map(file => file.path).sort(), authoredPaths);
  const mapped = new Set(inventory.records.filter(record => record.status === 'active').map(record => record.target));
  for (const file of inventory.authoredFiles) {
    if (file.status === 'removed') {
      assert.equal(existsSync(path.join(root, file.path)), false, file.path);
      assert.ok(file.removalReason?.trim());
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      continue;
    }
    assert.equal(file.status, 'active');
    assert.equal(file.origin, 'authored', file.path);
    assert.equal(Object.hasOwn(file, 'source'), false, `${file.path}: do not invent legacy provenance`);
    assert.equal(Object.hasOwn(file, 'sourceSha256'), false, `${file.path}: do not invent a legacy source hash`);
    assert.equal(mapped.has(file.path), false, `${file.path}: derived files belong in source mappings`);
    assert.ok(file.reason?.trim(), `${file.path}: missing authoring reason`);
    assert.match(file.sha256, /^[a-f0-9]{64}$/, file.path);
    assert.equal(hash(readFileSync(path.join(root, file.path))), file.sha256, `${file.path}: refresh provenance after an intentional reviewed change`);
  }
  function frontendFiles(directory) {
    return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
      const filename = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return ['node_modules', '.runtime'].includes(entry.name) ? [] : frontendFiles(filename);
      return entry.isFile() && filename !== 'apps/web/fork-inventory.json' ? [filename] : [];
    });
  }
  assert.deepEqual(frontendFiles('apps/web').sort(), [...mapped].filter(filename => filename.startsWith('apps/web/')).concat(authoredPaths).sort(), 'every maintained frontend file must be derived or explicitly authored');
});

test('original sources and current fork targets match their recorded SHA-256 values', () => {
  for (const record of inventory.records) {
    assert.match(record.sourceSha256, /^[a-f0-9]{64}$/, record.source);
    assert.match(record.targetSha256, /^[a-f0-9]{64}$/, record.target);
    assert.equal(hash(baseline(record.source)), record.sourceSha256, `${record.source}: baseline blob changed`);
    assert.ok(['active', 'removed'].includes(record.status), record.target);
    if (record.status === 'removed') {
      assert.ok(record.removalReason?.trim(), record.target);
      assert.equal(existsSync(path.join(root, record.target)), false, record.target);
    } else {
      assert.equal(hash(readFileSync(path.join(root, record.target))), record.targetSha256, `${record.target}: refresh provenance after an intentional reviewed change`);
    }
  }
  assert.deepEqual(inventory.originalSources.map(record => record.path).sort(), sourceFiles);
  for (const source of inventory.originalSources) {
    assert.equal(hash(baseline(source.path)), source.baselineSha256);
    if (source.status === 'removed') {
      assert.ok(source.removalReason?.trim(), source.path);
      assert.equal(existsSync(path.join(root, source.path)), false, source.path);
    } else {
      assert.equal(source.status, 'active');
      assert.equal(hash(readFileSync(path.join(root, source.path))), source.currentSha256, source.path);
    }
  }
});

test('historical regression tests retain provenance and intentional changes are explained', () => {
  const tests = inventory.records.filter(record => record.source.endsWith('.test.mjs'));
  const pure = tests.filter(record => record.target.startsWith('apps/web/'));
  const legacy = tests.filter(record => record.target.startsWith('test/web-fork-legacy/'));
  assert.equal(new Set(pure.map(record => record.source)).size, 34);
  assert.equal(pure.length, 35, 'historical tests plus the renamed operational-client target');
  assert.equal(legacy.length, 5);
  for (const record of pure.filter(record => record.status === 'active')) {
    if (record.sourceSha256 !== record.targetSha256) assert.ok(record.changes.some(change => typeof change === 'string' && change.trim()), `${record.target}: explain intentional regression changes`);
  }
  for (const record of legacy.filter(record => record.status === 'active')) {
    const fork = readFileSync(path.join(root, record.target), 'utf8');
    assert.equal(fork.replaceAll('../../apps/web/combined/', './').replaceAll('../../apps/combined/', './'), baseline(record.source).toString('utf8'), `${record.target}: only UI import paths may differ`);
  }
});

test('UI models imported directly by the existing Node writer remain byte-identical', () => {
  const serverFiles = ['server.js', ...readdirSync(path.join(root, 'lib'))
    .filter(name => /\.(?:js|mjs)$/.test(name)).map(name => `lib/${name}`)];
  const sharedModels = new Set();
  for (const file of serverFiles) {
    const code = readFileSync(path.join(root, file), 'utf8');
    for (const match of code.matchAll(/(?:from\s*|(?:import|require)\s*\(\s*)['"](\.\.\/apps\/combined\/[^'"]+)['"]/g)) {
      sharedModels.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
    }
  }
  assert.ok(sharedModels.has('apps/combined/dispatch-assignment.mjs'));
  assert.ok(sharedModels.has('apps/combined/delivery-bundles.mjs'));
  for (const source of sharedModels) {
    const record = inventory.records.find(item => item.source === source);
    assert.ok(record, `${source}: writer-owned UI dependency missing from inventory`);
    assert.deepEqual(readFileSync(path.join(root, record.target)), readFileSync(path.join(root, source)), `${source}: keep the fork aligned until the Node writer contract is deliberately migrated`);
  }
});
