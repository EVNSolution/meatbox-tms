// Both viewers use one connection per page, including the original customer renderer.
export function connectSimulation({ onState, onStatus, onError }) {
  let socket;
  let timer;
  let boot;
  let stopped = false;
  const login = () => location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash));

  async function connect() {
    if (stopped) return;
    onStatus(false, '배송 정보를 불러오고 있습니다.');
    try {
      const response = await fetch('/api/session', { headers: { accept: 'application/json' } });
      if (stopped) return;
      if (response.status === 401) return login();
      if (!response.ok) throw new Error('세션 확인 실패');
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${location.host}/ws/simulation`);
      socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'error') return onError('요청을 처리하지 못했습니다. 현재 단계를 확인하고 다시 시도해 주세요.');
        if (message.boot) {
          if (boot && boot !== message.boot) return location.reload();
          boot = message.boot;
        }
        if (message.type !== 'state') return;
        try { onState(message.state, { boot }); onStatus(true, ''); }
        catch { onStatus(false, '받은 배송 정보를 표시할 수 없습니다.'); }
      });
      socket.addEventListener('close', event => {
        if (stopped) return;
        onStatus(false, '연결이 끊겼습니다. 자동으로 다시 연결합니다.');
        if ([1008, 4401, 4403].includes(event.code) || /auth|login|session/i.test(event.reason)) return login();
        timer = setTimeout(connect, 1500);
      });
      socket.addEventListener('error', () => socket.close());
    } catch {
      if (stopped) return;
      onStatus(false, '서버에 연결할 수 없습니다. 자동으로 다시 연결합니다.');
      timer = setTimeout(connect, 1500);
    }
  }
  connect();
  return {
    send(type, extra = {}) {
      if (socket?.readyState !== WebSocket.OPEN) { onError('연결이 복구된 뒤 진행해 주세요.'); return; }
      socket.send(JSON.stringify({ type, ...extra }));
    },
    close() { stopped = true; clearTimeout(timer); socket?.close(); },
  };
}
