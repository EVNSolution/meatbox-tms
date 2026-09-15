'use strict';

// Keep one write in flight per viewer. Intermediate snapshots stay on the server
// as the single latest frame, not an unbounded queue attached to each socket.
function createStateSender({ latest, session, timeoutMs = 10_000 }) {
  return function sendState(ws) {
    if (ws.readyState !== 1 || ws.stateSending || ws.stateRevision === latest()?.revision) return;
    ws.stateSending = true;
    let finished = false;
    const timer = setTimeout(() => { ws.terminate(); finish(); }, timeoutMs);
    timer.unref?.();
    const onClose = () => finish();
    ws.once('close', onClose);

    function finish(error, revision) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ws.off('close', onClose);
      ws.stateSending = false;
      if (error) { ws.terminate(); return; }
      if (revision === undefined) return;
      ws.stateRevision = revision;
      if (latest()?.revision !== revision) sendState(ws);
    }

    (async () => {
      try {
        if (!await session(ws.token)) { ws.close(4401, 'Session ended'); finish(); return; }
        if (finished || ws.readyState !== 1) { finish(); return; }
        const frame = latest();
        const delta = ws.protocol === 'meatbox-state-v2' && ws.stateRevision === frame.baseRevision && frame.patch;
        ws.send(delta || frame.full, error => finish(error, frame.revision));
      } catch {
        ws.close(1011, 'Session unavailable');
        finish();
      }
    })();
  };
}

module.exports = { createStateSender };
