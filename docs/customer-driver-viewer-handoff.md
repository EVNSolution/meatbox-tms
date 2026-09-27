# 고객·배송원 뷰어 통합 인계

> **이력·검토 자료.** 아래 내용은 작성 당시의 계획·판정·시험 결과입니다. 수량·구현 상태·배포 여부를 현재 상태로 해석하지 않습니다. 현행 계약과 절차는 [문서 안내](README.md), 후속 전환 조건은 [운영 전환 기준](production-readiness.md)을 사용합니다.

## 범위와 작업 위치

- 브랜치: `codex/customer-viewer-scenarios`
- 작업 디렉터리: `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/07_MEATBOX_TMS/meatbox-customer-scenarios`
- 공통 기준: `94c85b2`
- `bd15f7e`: 고객뷰어의 임의 차량 위치와 6단계 로컬 시연.
- `8153204`: 배송원 근무 이력을 월간 달력 페이지로 수정.
- 이 문서가 포함된 마지막 커밋: 앱 내부 배송원 선택 제거, 외부 선택과 조회 대상 통일.
- 개별 배포, main 병합, 서버 교체는 하지 않았다. 배차·마커 작업과 통합 후 한 번에 검증·배포한다.

## 최종 동작

- 고객뷰어는 매장 근처 예시 차량 위치를 표시하며, 위치 재설정과 접수·피킹·출고 준비·배송 중·도착·완료 시연을 지원한다. 상태·시간·알림·지도 표시가 함께 바뀐다. 시연은 페이지 안에서만 작동하며 서버 배차·원본 주문·실제 완료 기록을 바꾸지 않는다.
- 배송원 근무 이력은 이전/다음 달 및 날짜 선택이 가능한 달력 페이지다. 이력 화면에서는 배송/지도 하단 탭을 숨긴다.
- 배송원 선택은 뷰어 외부의 기존 선택 상자 하나만 사용한다. 선택값은 앱 상단 이름과 이력 조회에 함께 적용된다. 미선택·잘못된 ID·이력 없는 날짜는 다른 배송원으로 대체하지 않는다.
- 동명이인 그룹은 선택된 원본 그룹으로 구분하고, 구분할 수 없으면 조회 결과를 표시하지 않는다. 이전 조회 응답이 늦게 도착해도 현재 배송원의 화면을 덮어쓰지 않는다.
- 원본 배차 이력에는 배송지·박스 수만 표시한다. 실제 근무 시작/종료 시간 데이터는 제공되지 않는다.

## 변경 파일

- 공통 계약: `DESIGN.md`
- 고객: `apps/combined/customer-renderer.mjs`, `customer-scenarios.mjs`, `customer-scenarios.test.mjs`, `mobile-customer-links.mjs`, `mobile-customer.css`, `mobile-customer.html`
- 시나리오/컨텍스트: `apps/combined/scenario-tools.mjs`, `scenario-tools.css`, `source-context.mjs`
- 배송원: `apps/combined/driver.mjs`, `driver.css`, `driver.html`, `driver-history.mjs`, `driver-history.test.mjs`, `driver-history-calendar.mjs`, `driver-history-calendar.test.mjs`
- 인계 기록: 이 문서.

## 로컬 검증

- 최종 `npm test`: **348/348 통과**. 로그: `.runtime/driver-identity-full-tests.log`.
- 수정 JavaScript 구문 검사 및 `git diff --check` 통과. 독립 코드 검토 승인, 추가 결함 없음.
- 고객 시연 구현 시 브라우저에서 단계별 상태·차량·알림·초기화·과거 날짜 제한과 390px 화면을 검증했다.
- 최종 배송원 브라우저 검증: 외부 선택만 존재, 상단 이름/이력 동기화, 선택 변경 후 달력 유지, 날짜 변경 시 동일 배송원 유지, 선택 해제 및 새로고침 후 다른 배송원 미표시.
- 실제 로컬 자료 확인: 9/16 김영국 27곳/37박스, 주봉식 17곳/17박스. 9/14 김영국 4곳/4박스, 주봉식은 빈 이력. 브라우저 콘솔 오류 0건.

## 통합 시 남은 확인

- 다른 작업과 겹치는 `driver.mjs`, `customer-renderer.mjs`, `scenario-tools.mjs`, `DESIGN.md`는 양쪽 의도를 보존해 병합한다.
- 통합 후 전체 테스트와 확정 배차를 선택한 배송원의 배송/지도/사진 완료, 고객 시연, 달력 조회를 다시 검증한다.
- 배포 및 배포된 SHA/HTTPS 런타임 검증은 통합 담당 작업에서 진행한다. 이 변경은 뷰어의 조회 대상 정합성 수정이며 계정별 서버 접근 제어를 새로 구현하지 않는다.
