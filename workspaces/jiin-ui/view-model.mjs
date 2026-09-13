import { filterTerminals, getTerminalSnapshots } from './sample-data.mjs';

export const pages = {
  deliveries: { title: '배송 현황', eyebrow: '배송 목록', description: '배송을 비교하고 확인할 배송을 선택합니다.' },
  control: { title: '단말 관제', eyebrow: '차량 장착형 TMS', description: '차량별 배송 진행과 도착 예정 시간, 알림을 확인합니다.' },
  customer: { title: '고객 보기', eyebrow: '선택 배송 미리보기', description: '같은 배송 결과가 고객에게 어떻게 안내되는지 확인합니다.' },
  design: { title: '디자인 가이드', eyebrow: '검토용', description: '실제 화면에서 사용하는 공통 요소와 배송 상태를 비교합니다.' },
};

export function pageFromHash(hash) {
  const page = hash.replace(/^#\//, '');
  return Object.hasOwn(pages, page) ? page : 'control';
}

export function viewModel(state) {
  const terminals = getTerminalSnapshots(state.scenario);
  const visible = filterTerminals(terminals, state.query, state.status).filter(terminal => !state.changedOnly || terminal.changed);
  const selected = visible.find(terminal => terminal.id === state.selectedId) ?? visible[0] ?? null;
  return { terminals, visible, selected };
}
