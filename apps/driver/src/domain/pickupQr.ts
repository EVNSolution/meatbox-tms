export type PickupScanResult =
  | { kind: 'ok'; orderId: string }
  | { kind: 'already'; orderId: string }
  | { kind: 'invalid' }
  | { kind: 'wrong_date'; date: string }
  | { kind: 'unknown'; orderId: string };

const QR_PATTERN = /^meatbox:(\d{4}-\d{2}-\d{2}):(.+)$/u;

export function parsePickupQr(raw: string): { date: string; orderId: string } | null {
  const match = QR_PATTERN.exec(raw.trim());
  if (!match || match[2].trim() === '') return null;
  return { date: match[1], orderId: match[2].trim() };
}

export function matchPickupQr(input: {
  raw: string;
  date: string;
  vehicleOrderIds: ReadonlySet<string>;
  scanned: ReadonlySet<string>;
}): PickupScanResult {
  const parsed = parsePickupQr(input.raw);
  if (!parsed) return { kind: 'invalid' };
  if (parsed.date !== input.date) return { kind: 'wrong_date', date: parsed.date };
  const { orderId } = parsed;
  // The app only knows this vehicle's orders, so another vehicle's order and a made-up one look the same.
  if (!input.vehicleOrderIds.has(orderId)) return { kind: 'unknown', orderId };
  return input.scanned.has(orderId) ? { kind: 'already', orderId } : { kind: 'ok', orderId };
}

export function pickupScanMessage(result: PickupScanResult, label?: string): string {
  switch (result.kind) {
    case 'ok':
      return `${label ?? result.orderId} 수령 확인`;
    case 'already':
      return `${label ?? result.orderId} 이미 확인한 주문입니다`;
    case 'invalid':
      return '미트박스 주문 QR이 아닙니다';
    case 'wrong_date':
      return `다른 날짜(${result.date})의 주문입니다`;
    case 'unknown':
      return '이 차량 배송 목록에 없는 주문입니다';
  }
}
