# 미트박스 프런트 포크·새 백엔드 결정

2026-10-05 확정. 제품은 **TypeScript/Vite 프런트 하나와 Kotlin/Spring API 하나**로 운영한다. 프런트는 기존 UI 요소를 `apps/web/`에 포크해 파일 단위로 관리하고, 백엔드는 `services/api/`에서 단계적으로 기존 계약을 인수한다.

## 모듈과 소유권

- `apps/web/`: 운영, 디자인 참조, 로그인, 등록 네 HTML 진입점
- `services/api/`: 인증·세션, 네 원본 읽기, 자원, 날짜별 배차·운행 상태
- Node gateway: 보호 정적 파일과 선택된 API owner 전달
- 기존 Node 핵심 모델: golden 비교와 롤백 근거

운영 `combined/app.mjs`가 헤더와 배차 관리·배송 관제·자원 관리 메뉴를 직접 소유한다. 디자인 가이드는 토큰과 실제 조작을 설명하는 참조 화면이며 별도 업무 상태나 시나리오를 실행하지 않는다.

## 저장소 구조

```text
meatbox-tms/
├─ apps/web/
│  ├─ combined/              운영 화면, 모델, HTTP client, CSS
│  ├─ ui-layout/             참조 전용 디자인 가이드
│  ├─ login/ · dev/register/ 인증 진입점
│  ├─ public/                theme와 portal 고정 자산
│  └─ scripts/               Vite·보호 게이트웨이 도구
├─ services/api/             Kotlin/Spring API
├─ test/api-connection/      실제 JAR 통합 계약
└─ deploy/new-stack/         환경별 패키징·전환·복구
```

실제 주문·계정·사진·checkpoint·비밀값은 정적 자산이나 Git에 넣지 않는다. 화면, 순수 모델, HTTP client, controller, store 책임은 [프로젝트 구조 안내](project-structure.md)에 따라 분리한다.

## 제거한 데모 경계

기사·고객 데모, 다섯 scenario 화면, 전용 이미지·CSS·모델·테스트, 떠다니는 시나리오 조작, 브라우저 WebSocket fallback은 새 제품에서 제거했다. Vite는 `/api`만 프록시한다. manifest 오류는 화면에 드러내며 합성 상태로 바꾸지 않는다. 지도는 source에 있는 좌표만 쓰고, 좌표가 없으면 no-data를 표시한다.

모든 gateway owner 모드는 `/scenario` 계열, `/customer`, `/driver`, `/present`, 두 combined 데모 HTML과 `/ws/simulation`을 410으로 닫는다. 실제 고객·기사 기능은 신원·권한·데이터 계약을 포함한 별도 제품 단위로 결정한다.

원본 UI도 API-only 경계로 정리한다. Node 핵심 API와 golden 모델, Sanghyun의 비 UI source, portal 글꼴·로고는 호환·복구를 위해 유지한다. 포크 provenance schema 3은 최초 142 source, 163 mapped target, 21 authored라는 역사를 보존하고 각 레코드의 active/removed 상태와 마지막 SHA를 기록한다. 현재 활성 수는 별도로 계산한다. 삭제 수와 로컬 검증은 [데모 삭제 결과](demo-removal-result.md)에 기록한다.

## 환경과 전환

| 환경 | 목적 | 승격 기준 |
| --- | --- | --- |
| TEST | 구현·통합·복구 검증 | 자동 검사, 실제 JAR, 인증 브라우저 smoke |
| QA | 운영과 분리된 사용자 검증 | TEST 후보의 동일 산출물과 QA 승인 |
| Production | 실제 업무 | QA 승인, 백업·rollback, 제한적 전환과 사후 확인 |

환경마다 origin, 쿠키, 저장소, 계정·세션, 비밀값, 백업, 알림 수신 대상과 공급자 자격 증명을 격리한다. 현재 서버 하나는 TEST로만 사용한다. QA와 Production은 준비될 때 같은 구조를 별도 구성한다.

전환 순서는 프런트 포크 → 기존 계약 parity → Kotlin 읽기 → 자원 writer → 인증·세션 → 날짜별 writer → Node API 중지다. 같은 날짜·자료 경계에는 writer를 하나만 둔다. 선택된 Kotlin owner가 실패하면 Node로 fallback하지 않는다.

현재 TEST native 모드에서 Kotlin이 인증·세션, 네 원본 읽기, 자원, 날짜별 상태와 여섯 명령을 소유한다. Node API 서비스는 중지돼 있고 Node gateway만 정적 파일과 Kotlin 프록시를 제공한다. Connected·legacy fixture는 비교와 rollback rehearsal이며 현재 TEST 소유권이 아니다. 실행 증거는 [Kotlin 상태 이관 결과](kotlin-state-migration-result.md)를 따른다.

## 완료 조건

- 프런트 typecheck·lint·build·테스트와 provenance 검사 통과
- Kotlin 단위·통합·detekt·bootJar 통과
- 실제 JAR에서 인증, 원본, 자원, 여섯 명령, CAS, 재시작 복원 검증
- 게이트웨이에서 owner marker, 401/403/404/410/503과 no-fallback 검증
- 패키지가 현재 working tree 바이트를 포함하고 삭제 파일을 되살리지 않음
- TEST 배포, 백업, rollback, 재적용, 인증 브라우저 확인

새 삭제 릴리스의 SHA·검사 수·배포 결과는 위 조건을 실제로 끝낸 결과 문서에서 기록한다. 과거 실행 수치를 새 결과로 복사하지 않는다. 개발 명령은 [개발 환경](new-stack-development.md)을 따른다.
