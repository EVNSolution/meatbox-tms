import { paginate } from './pagination-model.mjs';

const normalize = value => String(value ?? '').trim().toLocaleLowerCase('ko-KR');

export function updateCustomerPickerState(state = {}, change = {}) {
  const query = change.query ?? state.query ?? '';
  const queryChanged = Object.hasOwn(change, 'query') && normalize(query) !== normalize(state.query);
  return {
    query,
    page: queryChanged ? 1 : Math.max(1, Math.trunc(change.page ?? state.page) || 1),
  };
}

export function customerPickerPage(deliveries, state = {}, pageSize = 50) {
  const query = normalize(state.query);
  const filtered = query
    ? deliveries.filter(delivery => [delivery.id, delivery.name, delivery.address].some(value => normalize(value).includes(query)))
    : deliveries;
  return paginate(filtered, state.page, pageSize);
}
