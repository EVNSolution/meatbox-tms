import { createHash } from 'node:crypto';

const requests = [
  ['refrigerator', '매장 냉장고 안에 보관', '냉장고 보관 위치를 확인한 뒤 넣고 문이 닫혔는지 확인해 주세요.'],
  ['doorstep', '문 앞에 두기', '출입문을 막지 않는 위치에 놓고 포장 상태를 확인해 주세요.'],
  ['indoor', '매장 실내에 보관', '매장 안의 지정된 보관 위치에 놓아 주세요.'],
  ['handoff', '직접 전달', '수령인에게 물량을 확인한 뒤 직접 전달해 주세요.'],
];

// Presentation content is separate from imported records and applies only to the selected day.
export function presentationOrderContent(order, date) {
  if (date !== '2026-09-16') return {};
  const name = String(order?.name ?? '').normalize('NFC').trim();
  const address = String(order?.address ?? '').normalize('NFC').trim();
  const key = name && address ? `${name}\0${address}` : String(order?.id ?? '');
  const hash = createHash('sha256').update(key).digest('hex');
  const [kind, label, body] = requests[Number.parseInt(hash.slice(0, 8), 16) % requests.length];
  const content = {};
  if (order.customerRequests == null) content.customerRequests = {
    source: 'presentation', items: [{ id: `request_${hash.slice(0, 12)}`, kind, label, required: true }],
  };
  if (order.tip == null && order.customerRequests == null) content.tip = {
    body, author: '배송 안내', updatedAt: null, source: 'presentation',
  };
  if (order.transportConditions == null) {
    content.transportConditions = ['보냉 운송', '포장 상태 확인'];
    content.transportConditionSource = 'presentation';
  }
  if (Object.keys(content).length) content.presentationContent = { date, fields: Object.keys(content) };
  return content;
}
