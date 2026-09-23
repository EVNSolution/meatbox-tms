import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

if (process.argv.length !== 2) throw new Error('read password from stdin; arguments are not accepted');
const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (password.length < 12 || password.length > 1024) throw new Error('password must be 12 to 1024 characters');
const salt = randomBytes(32);
const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
process.stdout.write(`${salt.toString('hex')}:${key.toString('hex')}\n`);
