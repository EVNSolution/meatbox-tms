import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIREBASE_VERSION = '12.19.0';
const GSTATIC_APP = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = resolve(root, 'public/vendor');
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

async function build() {
  const packageJson = JSON.parse(await readFile(resolve(root, 'node_modules/firebase/package.json'), 'utf8'));
  if (packageJson.version !== FIREBASE_VERSION) throw new Error(`firebase input must be ${FIREBASE_VERSION}, found ${packageJson.version}`);

  const app = await readFile(resolve(root, 'node_modules/firebase/firebase-app.js'), 'utf8');
  const messagingInput = await readFile(resolve(root, 'node_modules/firebase/firebase-messaging.js'), 'utf8');
  const expectedImport = `from"${GSTATIC_APP}"`;
  const imports = messagingInput.match(/from"[^"]+"/g) || [];
  if (imports.length !== 1 || imports[0] !== expectedImport) {
    throw new Error(`unexpected firebase-messaging imports: ${JSON.stringify(imports)}`);
  }

  const appName = `firebase-app.${digest(app)}.mjs`;
  const messaging = messagingInput.replace(expectedImport, `from"./${appName}"`);
  if (messaging === messagingInput || /from"https?:\/\//.test(messaging)) throw new Error('firebase-messaging import rewrite failed');
  const messagingName = `firebase-messaging.${digest(messaging)}.mjs`;
  const loader = [
    `export { initializeApp, getApp, getApps } from './${appName}';`,
    `export { getMessaging, isSupported, onRegistered, register } from './${messagingName}';`,
    '',
  ].join('\n');

  await mkdir(vendor, { recursive:true });
  for (const name of await readdir(vendor)) {
    if (/^firebase-(?:app|messaging)\.[0-9a-f]{16}\.mjs$/.test(name) || name === 'firebase-vendor.mjs') await unlink(resolve(vendor, name));
  }
  await Promise.all([
    writeFile(resolve(vendor, appName), app),
    writeFile(resolve(vendor, messagingName), messaging),
    writeFile(resolve(vendor, 'firebase-vendor.mjs'), loader),
  ]);
  console.log(`Firebase ${FIREBASE_VERSION} vendor: ${appName}, ${messagingName}`);
}

await build();
