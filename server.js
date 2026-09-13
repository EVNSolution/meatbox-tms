// 미트박스 TMS 데모 서버 — 정적 서빙 + WebSocket 상태 브로드캐스트
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Simulation } = require('./src/simulation');
const routeData = require('./src/route-data');

const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/route-data', (_req, res) => res.json(routeData));
for (const view of ['customer', 'driver', 'control', 'present']) {
  app.get(`/${view}`, (_req, res) => res.sendFile(path.join(__dirname, 'public', `${view}.html`)));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let latest = null;
const sim = new Simulation((state) => {
  latest = state;
  const msg = JSON.stringify({ type: 'state', state });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
});

wss.on('connection', (ws) => {
  if (latest) ws.send(JSON.stringify({ type: 'state', state: latest }));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handle(msg); } catch (e) { console.error('command error:', e); }
  });
});

function handle(msg) {
  switch (msg.type) {
      case 'advance': sim.advance(); break;
      case 'reset': sim.reset(); break;
      case 'speed': sim.setSpeed(Number(msg.value)); break;
      case 'inject_traffic': sim.injectTraffic(); break;
      case 'inject_dwell': sim.injectDwell(); break;
      case 'reorder': sim.reorder(String(msg.stopId), msg.dir === 'up' ? 'up' : 'down'); break;
      case 'complete_stop': sim.completeCurrentStop(); break;
  }
}

server.listen(PORT, () => {
  console.log(`미트박스 TMS 데모: http://localhost:${PORT}`);
});
