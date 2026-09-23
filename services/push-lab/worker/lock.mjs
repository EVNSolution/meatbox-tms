import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { mkdir, unlink } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const socketPath = (key) => join(tmpdir(), `push-lab-${createHash('sha256').update(key).digest('hex').slice(0, 20)}.sock`);

function active(path) {
  return new Promise((resolveActive) => {
    const client = createConnection(path);
    client.once('connect', () => { client.destroy(); resolveActive(true); });
    client.once('error', () => resolveActive(false));
  });
}

async function acquireSocketFallback(key) {
  const path = process.env.WORKER_LOCK_PATH || socketPath(key);
  if (await active(path)) throw new Error('another push-lab worker holds the OS lock');
  await unlink(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  const server = createServer((socket) => socket.end());
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(path, resolveListen);
  });
  return {
    path,
    async release() {
      await new Promise((resolveClose) => server.close(resolveClose));
      await unlink(path).catch(() => {});
    },
  };
}

async function acquireFlock(key) {
  const path = resolve(process.env.WORKER_LOCK_PATH || `${key}.worker.lock`);
  await mkdir(dirname(path), { recursive: true });
  const holder = spawn('/usr/bin/flock', [
    '--nonblock', path, process.execPath, '-e',
    'process.stdout.write("locked\\n"); process.stdin.resume()',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const acquired = await new Promise((resolveAcquired, reject) => {
    let stderr = '';
    holder.stderr.setEncoding('utf8');
    holder.stderr.on('data', (chunk) => { stderr += chunk; });
    holder.stdout.setEncoding('utf8');
    holder.stdout.once('data', (chunk) => resolveAcquired(chunk.startsWith('locked')));
    holder.once('error', reject);
    holder.once('exit', (code) => {
      if (code === 1) resolveAcquired(false);
      else if (code !== 0) reject(new Error(`flock holder failed (${code}): ${stderr.trim()}`));
    });
  });
  if (!acquired) {
    holder.stdin.destroy();
    throw new Error('another push-lab worker holds the OS lock');
  }
  let released = false;
  return {
    path,
    async release() {
      if (released) return;
      released = true;
      holder.stdin.end();
      await new Promise((resolveExit) => {
        if (holder.exitCode != null) resolveExit();
        else holder.once('exit', resolveExit);
      });
    },
  };
}

export function acquireWorkerLock(key = process.env.DB_PATH || './data/push-lab.sqlite') {
  // Linux containers share this lock file through the same bind-mounted DB volume.
  // macOS has no bundled flock, so local tests retain the process-host socket lock.
  return platform() === 'linux' ? acquireFlock(key) : acquireSocketFallback(key);
}
