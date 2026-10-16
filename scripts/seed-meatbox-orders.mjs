// Pushes a few synthetic Meatbox orders for tomorrow into a running native fixture started with
// MEATBOX_FORK_FIXTURE_INBOUND_TOKEN (16+ characters), the way Meatbox would: fresh and parcel orders with item weights,
// one order without a weight on an item, one without coordinates and one outside every zone. Synthetic data only.
const args = Object.fromEntries(process.argv.slice(2).flatMap((item, index, all) => item.startsWith('--') ? [[item.slice(2), all[index + 1]]] : []));
const origin = String(args.origin ?? 'http://127.0.0.1:4173');
const token = String(args.token ?? process.env.MEATBOX_FORK_FIXTURE_INBOUND_TOKEN ?? '');
if (token.length < 16) throw new Error('Usage: node scripts/seed-meatbox-orders.mjs --token <inbound token, 16+ characters> [--origin <url>]');
const tomorrow = new Date(Date.parse(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const order = (id, deliveryType, name, lat, lng, items) => ({
  orderId: id, version: 1, status: 'active', deliveryDate: tomorrow, deliveryType, customer: { name },
  address: { road: `${name} 가상주소`, detail: '1층', ...(lat === null ? {} : { lat, lng }) }, items,
});
const orders = [
  order('MB-SEED-1', 'fresh', '합성 정육점 가', 37.53, 126.84, [{ sku: 'PK-1', qty: 3, boxes: 1, weightKg: 3.2 }, { sku: 'PK-2', qty: 1, boxes: 1, weightKg: 1.8 }]),
  order('MB-SEED-2', 'parcel', '합성 마트 나', 37.55, 126.82, [{ sku: 'PK-3', qty: 2, boxes: 2, weightKg: 6.5 }]),
  order('MB-SEED-3', 'fresh', '합성 식당 다', 37.52, 126.88, [{ sku: 'PK-4', qty: 1, boxes: 1, weightKg: 2 }, { sku: 'PK-5', qty: 1, boxes: 1 }]),
  order('MB-SEED-4', 'parcel', '합성 카페 라', null, null, [{ sku: 'PK-6', qty: 1, boxes: 1, weightKg: 1 }]),
  order('MB-SEED-5', 'fresh', '합성 정육점 마', 37.7, 127.2, [{ sku: 'PK-7', qty: 1, boxes: 1, weightKg: 4 }]),
];
for (const body of orders) {
  const response = await fetch(`${origin}/api/meatbox/orders`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `${body.orderId}:${body.version}` }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${body.orderId}: ${response.status} ${await response.text()}`);
}
console.log(JSON.stringify({ status: 'seeded', date: tomorrow, orders: orders.length }));
