import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDriverHistoryCalendar, shiftHistoryMonth } from './driver-history-calendar.mjs';

test('근무 달력은 월말과 윤년, 연도 경계를 넘겨도 유효한 날짜를 선택한다', () => {
  assert.equal(shiftHistoryMonth('2026-01-31', 1), '2026-02-28');
  assert.equal(shiftHistoryMonth('2028-01-31', 1), '2028-02-29');
  assert.equal(shiftHistoryMonth('2026-12-16', 1), '2027-01-16');
  assert.equal(shiftHistoryMonth('2026-01-16', -1), '2025-12-16');
});

test('페이지 달력은 요일별 월 전체와 선택일, 오늘, 원본 자료 표시를 구분한다', () => {
  const html = renderDriverHistoryCalendar('2026-09-14', [{ date: '2026-09-14' }, { date: '2026-09-16' }], '2026-09-16', true);
  assert.match(html, /<table aria-label="2026년 9월 근무 이력">/);
  assert.equal((html.match(/data-history-date=/g) || []).length, 30);
  assert.match(html, /data-history-date="2026-09-14"[^>]*aria-pressed="true"/);
  assert.match(html, /data-history-date="2026-09-16"[^>]*aria-pressed="false"[^>]*aria-current="date"/);
  assert.match(html, /2026.09.14 월요일, 배차 자료 있음/);
  assert.match(html, /원본 배차 자료가 있는 날/);
  assert.doesNotMatch(html, /type="date"|<dialog| disabled/);
});

test('예시 이력은 별도로 표시하고 기록 없는 날짜도 선택해 빈 상태를 조회한다', () => {
  const html = renderDriverHistoryCalendar('2026-09-13', ['2026-09-12', '2026-09-14'], '2026-09-16');
  assert.match(html, /2026.09.12 토요일, 예시 근무 이력 있음/);
  assert.match(html, /data-history-date="2026-09-13"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(html, /2026.09.13 일요일, 예시 근무 이력 있음/);
  assert.match(html, /예시 근무 이력이 있는 날/);
});
