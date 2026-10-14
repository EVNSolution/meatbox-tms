import { existsSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceRoot = resolve(process.cwd(), 'src');
const testFileSuffix = '.test.ts';

function collectTestFiles(path) {
  if (!existsSync(path)) {
    return [];
  }

  const stats = statSync(path);

  if (stats.isFile()) {
    return path.endsWith(testFileSuffix) ? [path] : [];
  }

  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const childPath = resolve(path, entry.name);

    if (entry.isDirectory()) {
      return collectTestFiles(childPath);
    }

    return entry.isFile() && childPath.endsWith(testFileSuffix)
      ? [childPath]
      : [];
  });
}

const requestedPaths = process.argv.slice(2);
const testFiles = (requestedPaths.length === 0
  ? collectTestFiles(sourceRoot)
  : requestedPaths.flatMap((path) => collectTestFiles(resolve(path)))
).map((path) => relative(process.cwd(), path));

if (testFiles.length === 0) {
  console.error(`No ${testFileSuffix} files found.`);
  process.exit(1);
}

const command = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
const result = spawnSync(command, ['--test', ...testFiles], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
