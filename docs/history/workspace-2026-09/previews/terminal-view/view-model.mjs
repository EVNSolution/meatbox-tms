import { filterTerminals, getTerminalSnapshots } from './sample-data.mjs';

export const pages = {
  orders: { title: '주문 관리', eyebrow: '운영 뷰어', description: '주문 정보와 배송 연결 상태를 확인합니다.' },
  deliveries: { title: '배송 목록', eyebrow: '운영 뷰어', description: '배송을 비교하고 확인할 배송을 선택합니다.' },
  control: { title: '배송 관제', eyebrow: '운영 뷰어', description: '차량별 배송 진행과 도착 예정 시간, 알림을 확인합니다.' },
  customer: { title: '고객 뷰어', eyebrow: '선택 배송 미리보기', description: '같은 배송 결과가 고객에게 어떻게 안내되는지 확인합니다.' },
  driver: { title: '배송원 뷰어', eyebrow: '배송 작업 미리보기', description: '선택 차량의 배송 정보와 현재 작업 상태를 확인합니다.' },
  design: { title: '디자인 가이드', eyebrow: '미트박스 UI 레퍼런스', description: '공식 브랜드에서 시작해, 배송을 더 명확하게 보여주는 화면으로.' },
};

export function viewerForPage(page) {
  return ['customer', 'driver'].includes(page) ? page : 'operations';
}

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
