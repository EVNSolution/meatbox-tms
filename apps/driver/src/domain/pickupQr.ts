export type PickupScanResult =
  | { kind: 'ok'; orderId: string }
  | { kind: 'already'; orderId: string }
  | { kind: 'invalid' }
  | { kind: 'wrong_date'; date: string }
  | { kind: 'other_vehicle'; orderId: string }
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
  allOrderIds: ReadonlySet<string>;
  scanned: ReadonlySet<string>;
}): PickupScanResult {
  const parsed = parsePickupQr(input.raw);
  if (!parsed) return { kind: 'invalid' };
  if (parsed.date !== input.date) return { kind: 'wrong_date', date: parsed.date };
  const { orderId } = parsed;
  if (!input.vehicleOrderIds.has(orderId)) {
    return input.allOrderIds.has(orderId)
      ? { kind: 'other_vehicle', orderId }
      : { kind: 'unknown', orderId };
  }
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
    case 'other_vehicle':
      return '다른 차량에 배정된 주문입니다';
    case 'unknown':
      return '오늘 배차에 없는 주문입니다';
  }
}
