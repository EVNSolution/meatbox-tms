import type { FleetDelivery } from './dispatch';
import { MAX_CODE_LENGTH, MAX_SCANNED_CODES } from './scanPolicy';

// What the driver reports for one stop, and the event the server expects for it (docs/integration-contract.md 2).

export const NOTE_MAX = 500;

export const REASON_CODES = [
  { code: 'ABSENT', label: '고객 부재' },
  { code: 'ACCESS_DENIED', label: '출입 불가' },
  { code: 'ADDRESS_MISMATCH', label: '주소 불일치' },
  { code: 'REFUSED', label: '수령 거부' },
  { code: 'NO_STORAGE', label: '보관 불가' },
  { code: 'OTHER', label: '기타' },
] as const;
export type ReasonCode = (typeof REASON_CODES)[number]['code'];

export type PartialItem = { sku: string; name: string; orderedQty: number; deliveredQty: number };

export type StopDraft =
  | { kind: 'completed'; note: string; scannedCodes?: string[] }
  | { kind: 'failed'; reasonCode: ReasonCode | null; note: string }
  | { kind: 'partial'; items: PartialItem[]; note: string };

export type StopEventType = 'stop_completed' | 'stop_failed' | 'stop_partially_completed';

export const STOP_EVENT_TYPES: readonly string[] = ['stop_completed', 'stop_failed', 'stop_partially_completed'];

/** The items of a single-order stop. Null when the stop has several orders or no usable items (no partial delivery). */
export function partialItemsFor(orders: readonly FleetDelivery[]): PartialItem[] | null {
  if (orders.length !== 1) return null;
  const items = (orders[0].items ?? []).flatMap((item) => {
    const sku = typeof item.sku === 'string' ? item.sku.trim() : '';
    const qty = item.qty;
    return sku && typeof qty === 'number' && Number.isFinite(qty) && qty > 0
      ? [{ sku, name: item.name?.trim() || sku, orderedQty: qty, deliveredQty: qty }]
      : [];
  });
  return items.length > 0 ? items : null;
}

/** Codes the server accepts: at most 200, each 1 to 128 characters without spaces, none twice. */
function validCodes(codes: readonly string[]): boolean {
  return codes.length <= MAX_SCANNED_CODES && new Set(codes).size === codes.length
    && codes.every((code) => code.length > 0 && code.length <= MAX_CODE_LENGTH && !/\s/u.test(code));
}

/** The sentence to show when the draft cannot be sent, else null. */
export function draftProblem(draft: StopDraft, photoCount: number, requirePhoto: boolean): string | null {
  if (draft.note.trim().length > NOTE_MAX) return `특이사항은 ${NOTE_MAX}자까지 쓸 수 있습니다.`;
  if (draft.kind === 'completed' && requirePhoto && photoCount < 1) return '완료 사진을 1장 이상 첨부해 주세요.';
  if (draft.kind === 'completed' && !validCodes(draft.scannedCodes ?? [])) return '읽은 코드 목록을 확인해 주세요.';
  if (draft.kind === 'failed' && !draft.reasonCode) return '미배송 사유를 선택해 주세요.';
  if (draft.kind === 'partial') {
    const valid = draft.items.length > 0 && draft.items.every((item) =>
      Number.isFinite(item.deliveredQty) && item.deliveredQty >= 0 && item.deliveredQty <= item.orderedQty);
    if (!valid) return '배송 수량은 0 이상, 주문 수량 이하여야 합니다.';
    if (draft.items.every((item) => item.deliveredQty === item.orderedQty)) {
      return '모든 수량이 주문과 같습니다. 완료로 처리해 주세요.';
    }
  }
  return null;
}

/**
 * The event type and payload (without `photoIds`, which exist only after the upload) for [draft] at [stopId].
 * [orderId] is the single order of a partial delivery. Throws on a draft that [draftProblem] would refuse.
 */
export function buildStopEvent(
  stopId: string,
  draft: StopDraft,
  orderId: string,
): { type: StopEventType; payload: Record<string, unknown> } {
  const problem = draftProblem(draft, Number.MAX_SAFE_INTEGER, false);
  if (problem) throw new Error(problem);
  const note = draft.note.trim();
  const withNote = (payload: Record<string, unknown>) => (note ? { ...payload, note } : payload);
  switch (draft.kind) {
    case 'completed':
      return {
        type: 'stop_completed',
        payload: withNote({ stopId, ...(draft.scannedCodes?.length ? { scannedCodes: draft.scannedCodes } : {}) }),
      };
    case 'failed':
      return { type: 'stop_failed', payload: withNote({ stopId, reasonCode: draft.reasonCode }) };
    case 'partial':
      return {
        type: 'stop_partially_completed',
        payload: withNote({
          stopId,
          orderId,
          items: draft.items.map(({ sku, deliveredQty, orderedQty }) => ({ sku, deliveredQty, orderedQty })),
        }),
      };
  }
}
