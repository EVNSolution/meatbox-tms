import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createDispatchFleet } from '../apps/combined/dispatch-assignment.mjs';

const require = createRequire(import.meta.url);
const { importResourceCatalog } = require('../lib/resource-store.js');

function argumentsFrom(argv) {
  if (argv.length !== 4 || argv[0] !== '--day' || argv[2] !== '--output' ||
    !path.isAbsolute(argv[1]) || !path.isAbsolute(argv[3]) || argv[1] === argv[3]) {
    throw new Error('Usage: node scripts/import-resource-catalog.mjs --day /absolute/day.json --output /absolute/resources.sqlite');
  }
  return { dayPath: argv[1], output: argv[3] };
}

function catalog(day) {
  const fleet = createDispatchFleet(day);
  const groups = new Map(day.groups.map(group => [group.id, group]));
  return fleet.map(vehicle => {
    const label = groups.get(vehicle.id).label.trim();
    const match = /^\(([A-Za-z][A-Za-z0-9]{0,39})\)/.exec(label);
    const active = Boolean(match) && !label.includes('용차');
    return { id: vehicle.id, plate: vehicle.plate, originalCode: active ? match[1] : null, active };
  });
}

try {
  const { dayPath, output } = argumentsFrom(process.argv.slice(2));
  const raw = fs.readFileSync(dayPath);
  const day = JSON.parse(raw.toString('utf8'));
  const fingerprint = createHash('sha256').update(raw).digest('hex');
  const vehicles = catalog(day);
  const result = importResourceCatalog({ output, fingerprint, vehicles });
  console.log(`${result}: ${vehicles.length} catalog records`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
