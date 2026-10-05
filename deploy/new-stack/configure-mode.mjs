#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const [mode, apiInput, webInput, ownersInput, outputDirectory] = process.argv.slice(2);
if (!['connected', 'native'].includes(mode) || ![apiInput, webInput, ownersInput, outputDirectory].every(Boolean)) {
  throw new Error('usage: configure-mode.mjs connected|native API_ENV WEB_ENV OWNERS_ENV OUTPUT_DIRECTORY');
}

const KEY = /^[A-Z][A-Z0-9_]*$/;

async function read(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`environment input must be a regular file: ${filename}`);
  return fs.readFile(filename, 'utf8');
}

function parse(source, name) {
  const lines = source.split(/\r?\n/);
  const values = new Map();
  for (const line of lines) {
    if (!line || /^\s*#/.test(line)) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || !KEY.test(match[1])) throw new Error(`invalid environment line in ${name}`);
    if (values.has(match[1])) throw new Error(`duplicate environment key in ${name}: ${match[1]}`);
    if (/[\0\r\n]/.test(match[2])) throw new Error(`invalid environment value in ${name}: ${match[1]}`);
    values.set(match[1], match[2]);
  }
  return { lines, values };
}

function exactPublicOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('MEATBOX_PUBLIC_ORIGIN must already be an exact HTTPS origin'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('MEATBOX_PUBLIC_ORIGIN must already be an exact HTTPS origin');
  }
  return value;
}

function update(parsed, updates) {
  const pending = new Map(Object.entries(updates));
  const lines = [];
  for (const line of parsed.lines) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (match && pending.has(match[1])) {
      lines.push(`${match[1]}=${pending.get(match[1])}`);
      pending.delete(match[1]);
    } else if (line || lines.length) {
      lines.push(line);
    }
  }
  while (lines.at(-1) === '') lines.pop();
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  return `${lines.join('\n')}\n`;
}

const api = parse(await read(apiInput), 'api.env');
const web = parse(await read(webInput), 'web.env');
const owners = parse(await read(ownersInput), 'owners.env');
const publicOrigin = exactPublicOrigin(api.values.get('MEATBOX_PUBLIC_ORIGIN'));
const webOrigin = web.values.get('MEATBOX_LEGACY_PUBLIC_ORIGIN');
if (webOrigin && webOrigin !== publicOrigin) throw new Error('web and API public origins must match');

const native = mode === 'native';
const apiOutput = update(api, {
  SERVER_PORT: '8081',
  MEATBOX_COMPAT_ENABLED: 'true',
  MEATBOX_LEGACY_API_ORIGIN: 'http://127.0.0.1:3001',
  MEATBOX_DISPATCH_DATA_DIR: '/opt/meatbox-demo/datasets/0b7107924f0ce822a95125c4b7eb0c1498fc4ea7f066e76ce951bcdac1ed7005',
  MEATBOX_RESOURCES_ENABLED: 'true',
  MEATBOX_RESOURCE_DATABASE: '/var/lib/meatbox-demo/resources/resources.sqlite',
  MEATBOX_AUTH_ENABLED: native ? 'true' : 'false',
  MEATBOX_AUTH_ACCESS_FILE: '/var/lib/meatbox-demo/access.json',
  MEATBOX_DISPATCH_ENABLED: native ? 'true' : 'false',
  MEATBOX_DISPATCH_STATE_DIR: '/var/lib/meatbox-demo/dispatch-state',
  MEATBOX_PUBLIC_ORIGIN: publicOrigin,
});
const webOutput = update(web, {
  MEATBOX_LEGACY_GATEWAY_PORT: '4173',
  MEATBOX_LEGACY_PUBLIC_ORIGIN: publicOrigin,
  MEATBOX_LEGACY_API_ORIGIN: 'http://127.0.0.1:3001',
  MEATBOX_KOTLIN_API_ORIGIN: 'http://127.0.0.1:8081',
});
const ownersOutput = update(owners, {
  MEATBOX_AUTH_OWNER: native ? 'kotlin' : 'node',
  MEATBOX_DISPATCH_OWNER: native ? 'kotlin' : 'node',
  MEATBOX_RESOURCES_OWNER: 'kotlin',
});

await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
for (const [name, contents] of [['api.env', apiOutput], ['web.env', webOutput], ['owners.env', ownersOutput]]) {
  const filename = path.join(outputDirectory, name);
  await fs.writeFile(filename, contents, { mode: 0o600, flag: 'wx' });
  await fs.chmod(filename, 0o600);
}
