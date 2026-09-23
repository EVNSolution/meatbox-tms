import { openDatabase } from './db.mjs';
import { PushLabService } from './service.mjs';

const [command, ...pairs] = process.argv.slice(2);
const options = Object.fromEntries(pairs.map((pair) => pair.replace(/^--/, '').split('=')));
const db = openDatabase();
const service = new PushLabService(db);
try {
  if (command === 'create') {
    const result = options.probe === 'true'
      ? service.createDeploymentProbe({ userId: options.user, inviteCode: options.invite })
      : service.createFixture({ deliveryId: options.delivery, userId: options.user, inviteCode: options.invite });
    console.log(JSON.stringify(result));
  } else if (command === 'emit-test-event') {
    const result = service.emitEvent({
      eventId: options.event,
      deliveryId: options.delivery,
      revision: Number(options.revision || 1),
      stage: options.stage,
      notificationType: options.type || 'delivery_update',
      expiresAt: Date.now() + Number(options.ttl || 300_000),
    });
    console.log(JSON.stringify(result));
  } else if (command === 'inspect-probe') {
    const delivery = db.prepare('SELECT id,scope,deliverable FROM deliveries WHERE id=?').get(options.delivery);
    if (!delivery || delivery.scope !== 'deployment_probe') throw new Error('deployment probe not found');
    const outboxCount = db.prepare(`SELECT count(*) AS count FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.delivery_id=?`)
      .get(delivery.id).count;
    console.log(JSON.stringify({ deliveryId: delivery.id, scope: delivery.scope, deliverable: Boolean(delivery.deliverable), outboxCount }));
  } else if (command === 'cleanup-probe') {
    console.log(JSON.stringify(service.cleanupDeploymentProbe(options.delivery)));
  } else {
    throw new Error('usage: fixture create --user=... [--delivery=...] [--invite=...] [--probe=true] | emit-test-event --event=... --delivery=... | inspect-probe --delivery=... | cleanup-probe --delivery=...');
  }
} finally {
  db.close();
}
