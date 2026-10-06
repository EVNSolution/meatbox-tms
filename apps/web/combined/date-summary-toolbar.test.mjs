import test from 'node:test';
import assert from 'node:assert/strict';
import { dateSummaryToolbar, mountDateSummaryToolbar } from './date-summary-toolbar.mjs';

test('두 운영 화면은 같은 날짜 툴바 구조에 날짜 동작과 집계를 배치한다', () => {
  const html = dateSummaryToolbar({ label: '관제 조회 날짜', actions: '<button id="today">오늘</button>', context: '<span id="readonly">읽기 전용</span>', summaryLabel: '선택 관제일 요약', actionsClass: 'control-date-actions' });
  assert.match(html, /class="date-summary-toolbar"/);
  assert.match(html, /class="date-summary-actions control-date-actions"/);
  assert.match(html, /id="today"/);
  assert.match(html, /class="date-summary-meta"><span id="readonly">읽기 전용<\/span><div class="summary-counts"/);
  assert.match(html, /class="summary-counts" data-date-summary hidden aria-label="선택 관제일 요약"/);
});

test('날짜 집계는 항목을 갱신하고 로딩 또는 빈 상태에서 이전 수치를 지운다', () => {
  const summary = { hidden: true, innerHTML: '' };
  const toolbar = mountDateSummaryToolbar({ querySelector: selector => selector === '[data-date-summary]' ? summary : null });
  toolbar.update([['주문', 1234], ['박스', 5678], ['후보 차량', 31]]);
  assert.equal(summary.hidden, false);
  assert.match(summary.innerHTML, /주문.*1,234.*박스.*5,678.*후보 차량.*31/);
  toolbar.clear();
  assert.equal(summary.hidden, true);
  assert.equal(summary.innerHTML, '');
  toolbar.update([['차량', 2], ['배송', 8], ['완료', 3]]);
  assert.match(summary.innerHTML, /차량.*2.*배송.*8.*완료.*3/);
});
