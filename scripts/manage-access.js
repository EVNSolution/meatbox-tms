#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createAccess, AccessError } = require('../lib/access');

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function writeSecret(file, secret) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${secret}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

async function main(args = process.argv.slice(2)) {
  const command = args[0];
  const file = path.resolve(option(args, '--file') || process.env.ACCESS_FILE || '');
  if (!command || !file || file === path.resolve('')) {
    throw new AccessError('VALIDATION', 'Usage: manage-access.js <issue-invite|disable-user> --file <access.json> [options]');
  }
  const access = createAccess({ file });

  if (command === 'issue-invite') {
    const requestedOutput = option(args, '--output');
    const output = path.resolve(requestedOutput || path.join(path.dirname(file), `invite-${Date.now()}.txt`));
    const hours = Number(option(args, '--hours') || 24);
    if (!Number.isFinite(hours) || hours <= 0) throw new AccessError('VALIDATION', '--hours must be a positive number.');
    const invite = await access.issueInvite({ expiresInMs: hours * 60 * 60 * 1000 });
    await writeSecret(output, invite);
    process.stdout.write(`${output}\n`);
    return;
  }

  if (command === 'disable-user') {
    const username = option(args, '--username');
    if (!username) throw new AccessError('VALIDATION', '--username is required.');
    await access.disableUser(username);
    process.stdout.write(`Disabled ${username.toLowerCase()}\n`);
    return;
  }

  throw new AccessError('VALIDATION', `Unknown command: ${command}`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof AccessError ? error.message : 'Access management failed.'}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
