#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: configure-push-session-url.mjs INPUT_ENV OUTPUT_ENV');
  process.exit(64);
}

const OLD_URL = 'http://127.0.0.1:3001/api/session';
const NEW_URL = 'http://127.0.0.1:8081/api/session';
const PREFIX = Buffer.from('PUSH_LAB_TMS_SESSION_URL=');
const source = fs.readFileSync(input);
const matches = [];
let lineStart = 0;
while (lineStart <= source.length) {
  const newline = source.indexOf(0x0a, lineStart);
  const lineEnd = newline === -1 ? source.length : newline;
  const contentEnd = lineEnd > lineStart && source[lineEnd - 1] === 0x0d ? lineEnd - 1 : lineEnd;
  const line = source.subarray(lineStart, contentEnd);
  if (line.subarray(0, PREFIX.length).equals(PREFIX)) {
    matches.push({ start: lineStart, end: contentEnd, value: line.subarray(PREFIX.length) });
  }
  if (newline === -1) break;
  lineStart = newline + 1;
}

if (matches.length !== 1) {
  throw new Error('push-lab env must contain exactly one PUSH_LAB_TMS_SESSION_URL');
}
const value = matches[0].value.toString('utf8');
if (value !== OLD_URL && value !== NEW_URL) {
  throw new Error(`unexpected PUSH_LAB_TMS_SESSION_URL: ${value}`);
}

const configured = value === NEW_URL
  ? source
  : Buffer.concat([
      source.subarray(0, matches[0].start + PREFIX.length),
      Buffer.from(NEW_URL),
      source.subarray(matches[0].end),
    ]);

fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
fs.writeFileSync(output, configured, { mode: 0o600 });
