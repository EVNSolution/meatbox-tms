import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? collect(filename)
      : entry.isFile() && entry.name.endsWith(".test.mjs") ? [filename] : [];
  }));
  return files.flat();
}

const tests = (await Promise.all(["combined", "ui-layout", "src", "test"]
  .map(directory => collect(path.join(root, directory))))).flat().sort();
if (!tests.length) throw new Error("No frontend tests found");
const result = spawnSync(process.execPath, ["--test", ...tests], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
