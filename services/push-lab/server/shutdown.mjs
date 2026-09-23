export async function drainHttpServer(server, { graceMs = 30_000 } = {}) {
  server.beginDrain();
  let timer;
  const closed = new Promise((resolve) => {
    server.close((error) => resolve({ forced: false, error: error || null }));
  });
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ forced: true, error: null }), graceMs);
  });
  const result = await Promise.race([closed, timeout]);
  clearTimeout(timer);
  if (result.forced) {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    return result;
  }
  if (result.error) {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    throw result.error;
  }
  return result;
}
