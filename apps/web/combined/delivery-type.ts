// 신선/택배: the delivery kind that Meatbox sends per order (`deliveryType`). The prepared CSV days have none, which the
// screen says instead of pretending that every order is one kind. The filter changes what the dispatch screen shows
// (map, zones, vehicle loads); calculating and sending a dispatch still use every order.

export type TypeFilter = 'all' | 'fresh' | 'parcel';
export const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: '전체' }, { value: 'fresh', label: '신선' }, { value: 'parcel', label: '택배' },
];
type Typed = { deliveryType?: unknown };

export type TypeCounts = { fresh: number; parcel: number; unknown: number; total: number };

export function typeCounts(orders: Typed[] | null | undefined): TypeCounts {
  const list = Array.isArray(orders) ? orders : [];
  const fresh = list.filter(order => order.deliveryType === 'fresh').length;
  const parcel = list.filter(order => order.deliveryType === 'parcel').length;
  return { fresh, parcel, unknown: list.length - fresh - parcel, total: list.length };
}

/** The orders of one kind, or the same array for "all". An order without a kind is in no kind. */
export function filterByType<T extends Typed>(orders: T[] | null | undefined, filter: TypeFilter): T[] | null | undefined {
  if (filter === 'all' || !Array.isArray(orders)) return orders;
  return orders.filter(order => order.deliveryType === filter);
}

/** Whether the day has any kind at all: only Meatbox orders carry it. */
export const hasTypes = (counts: TypeCounts): boolean => counts.fresh + counts.parcel > 0;

export function typeNote(counts: TypeCounts, filter: TypeFilter): string {
  if (!counts.total) return '';
  if (!hasTypes(counts)) return '이 날짜 원본(CSV)에는 배송 구분이 없어 구분별로 나눌 수 없습니다. 구분은 미트박스 주문(deliveryType)에서만 들어옵니다.';
  const unknown = counts.unknown ? ` 구분이 없는 주문 ${counts.unknown.toLocaleString('ko-KR')}건은 전체에서만 보입니다.` : '';
  const shown = filter === 'all' ? '' : `${filter === 'fresh' ? '신선' : '택배'}만 표시 중입니다. `;
  return `${shown}배차 계산과 전송은 구분과 관계없이 전체 주문 기준입니다.${unknown}`;
}
