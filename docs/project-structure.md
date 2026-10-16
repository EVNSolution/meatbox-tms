# 어떤 파일을 고치면 되는가

프런트는 `apps/web/` 하나를 빌드·배포한다. HTML 진입점은 운영, 디자인 참조, 로그인, 등록 네 개다. 서버는 `services/api/`의 Kotlin 프로젝트이며 화면 표시, HTTP 요청, 계산, 저장 책임을 나눠 관리한다.

## 기능별 수정 위치

| 고치려는 내용 | 주로 볼 파일 | 책임 |
| --- | --- | --- |
| 운영 헤더·메뉴·화면 연결 | `apps/web/combined/app.mjs` | 배차 관리, 배송 관제, 자원 관리 화면을 연결한다. |
| 배차 계산·확정 화면 | `apps/web/combined/dated-dispatch.mjs`, `order-planning.mjs`, `dispatch-workflow.mjs` | 날짜 자료를 표시하고 여섯 서버 명령을 호출한다. |
| 배송 관제 화면 | `apps/web/combined/vehicle-control.mjs`와 인접 모델 | 확정 운행 기록과 원본 좌표를 표시한다. |
| 배송 순서 편집 | `apps/web/combined/route-editor.mjs` | 편집안을 관리하고 보호 상태·최신 순서 조건으로 저장한다. |
| 자원 관리 화면·요청 | `apps/web/combined/resource-management.mjs`, `resource-client.mjs` | 차량·지역 코드를 표시하고 Kotlin 자원 API를 호출한다. |
| 운영 연결·명령 전달 | `apps/web/combined/operations-client.mjs` | 세션·원본 가용성을 확인하고 명령의 묶음 ID를 원본 주문 ID로 확장한다. |
| 날짜별 원본 요청 | `apps/web/combined/source-client.mjs` | 네 원본 조회, 세션 만료, 재요청을 처리한다. |
| 운영 자료 변환 | `apps/web/combined/operations-adapter.mjs` | 날짜별 운영 snapshot을 검증하고 화면의 배송지 묶음으로 변환한다. 합성 시뮬레이션 상태는 받지 않는다. |
| 디자인 참조 | `apps/web/ui-layout/` | 현재 토큰과 실제 조작을 설명하며 제품 상태를 쓰지 않는다. |
| 로그인·등록 | `apps/web/src/auth.ts`, `auth-contract.ts`, `login/`, `dev/register/` | 인증 입력과 세션 계약을 관리한다. |
| 공통 색·글꼴·기본 크기 | `apps/web/public/theme.css` | 운영·인증·가이드가 같은 기준을 사용하게 한다. 폰트는 `public/portal-font.ttf`, 라이선스는 `public/combined/assets/OFL-1.1.txt` 하나씩 유지한다. |
| 공통 UI 컴포넌트 | `apps/web/public/components.css`, `apps/web/src/shared/ui/` | 버튼·입력·카드·탭·대화상자 스타일과 상단 알림을 공유한다. 날짜 조작은 `combined/date-picker.*`, 날짜 집계 배치는 `combined/date-summary-toolbar.*`에서 관리한다. |
| 보호 정적 파일·라우팅 | `apps/web/scripts/legacy-gateway.mjs`, `api-routing.mjs` | 세션 검사, API owner 전달, 폐기 URL의 410을 처리한다. |
| Kotlin 인증 | `services/api/src/main/kotlin/com/evnsolution/meatbox/auth/` | 로그인·등록·로그아웃·세션과 access JSON v1 호환을 담당한다. |
| Kotlin 자원 | `services/api/src/main/kotlin/com/evnsolution/meatbox/resources/` | SQLite v2 조회·저장·버전 충돌·트랜잭션을 담당한다. |
| Kotlin 원본 조회 | `services/api/src/main/kotlin/com/evnsolution/meatbox/legacy/` | 기존 네 원본 형식과 읽기 API를 보존한다. 일반·gzip day 본문 날짜를 요청 날짜와 대조한다. |
| Kotlin 날짜별 상태 | `services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/` | 여섯 명령, 계산, 확정 운행 기록, CAS checkpoint를 담당한다. |
| Kotlin 외부 연동 | `services/api/src/main/kotlin/com/evnsolution/meatbox/integrations/` | 서버가 밖과 주고받는 코드를 모은다. 아래 `integrations/` 절을 따른다. |
| 배포·복구 | `deploy/new-stack/` | 환경 설정, 패키징, 전환과 롤백을 관리한다. |

## Kotlin `integrations/`

서버 밖과 주고받는 코드는 `integrations/` 아래에 둔다. 패키지 이름이 호출 방향과 상대를 말한다.

| 패키지 | 방향 | 내용 |
| --- | --- | --- |
| `integrations/meatbox/inbound/` | 미트박스 → 서버 | `POST /api/meatbox/orders`: 본문 검증·매핑(`InboundOrder`), 날짜별 수신 파일과 변경·취소 정책(`InboundOrders`), 토큰 필터, 컨트롤러 |
| `integrations/meatbox/outbound/` | 서버 → 미트박스 | 배송 상태 송신함(`Outbox`), 발송기(`OutboxSender`), HTTP 클라이언트(`MeatboxClient`) |
| `integrations/meatbox/mock/` | 테스트 전용 | `/mock/meatbox/*` 모의 수신기. 기본 꺼짐 |
| `integrations/fcm/` | 서버 → FCM | 기사 앱 푸시 발송 |
| `integrations/webhook/` | 서버 → 알림 수신처 | 운영 알림 웹훅 채널. 채널 인터페이스(`AlertChannel`)와 로그 채널은 `ops/`에 둔다 |

`legacy/`는 기존 Node 서비스의 원본 파일·세션 계약을 읽는 호환 코드다(속성 접두사 `meatbox.compat.*`와 환경 변수는 그대로다). `dispatch/`는 `Outbox`를 직접 쓰므로 `dispatch`와 `integrations/meatbox/outbound`는 서로 참조한다.

## 수정 원칙

화면 표시를 바꾸면 해당 화면 파일부터 수정하고, 저장 규칙을 바꾸면 Kotlin store와 관련 테스트를 함께 수정한다. 공통 토큰은 `theme.css`에 두되 한 번만 쓰는 조각 때문에 새 계층을 만들지 않는다. 순수 계산과 선택 규칙은 DOM 코드에서 분리하고, 테스트는 인접 `.test.mjs` 또는 Kotlin 테스트에 둔다.

날짜별 업무 명령은 `calculate_dispatch`, `reassign`, `publish_dispatch`, `begin_dispatch_revision`, `discard_dispatch_revision`, `set_route_order` 여섯 개다. 화면은 이 계약만 호출한다. 기존 고객 알림·보류 기록 조회를 새 알림 발송이나 보류 변경 기능으로 확장하지 않는다.

manifest가 없거나 잘못됐으면 화면에 조회 오류를 표시한다. WebSocket이나 합성 상태로 조용히 바꾸지 않는다. 지도는 선택한 원본에 이미 있는 좌표만 쓰며, 좌표가 없으면 자료 없음으로 표시한다.

## 삭제가 완료된 데모 경계

기사·고객 데모, 다섯 scenario 진입점, 전용 이미지·CSS·모델·테스트, 떠다니는 시나리오 조작과 scenario WebSocket 클라이언트는 제품 트리에서 제거했다. 디자인 가이드는 참조 화면으로만 남고, 운영 `app.mjs`가 헤더와 메뉴를 직접 소유한다. Vite는 `/api`만 프록시한다.

`/scenario` 계열, `/customer`, `/driver`, `/present`, 두 combined 데모 HTML, `/ws/simulation`은 owner 설정과 관계없이 410을 반환한다. 실제 고객·기사 기능은 별도 요구사항, 신원, 권한, 데이터 계약을 승인한 뒤 새로 설계한다.

원본 트리에서도 운영 UI는 제거했지만 Node 핵심 API·golden 비교 모델, Sanghyun의 비 UI source, portal 글꼴·로고는 호환·복구 근거로 유지한다. 포크 인벤토리는 최초 142 source, 163 mapped target, 21 authored라는 이력과 각 항목의 active/removed 상태 및 마지막 SHA를 함께 보존한다. 현재 활성 파일 수는 인벤토리에서 계산하며 역사적 총계와 섞지 않는다. 삭제 범위와 검증 결과는 [기존 데모 삭제 결과](demo-removal-result.md)를 따른다.

TEST native 구성에서는 Kotlin이 로그인·세션, 원본 조회, 자원, 날짜별 배차 writer를 소유한다. Node API 서비스를 중지하고 프런트 게이트웨이는 정적 파일과 Kotlin 프록시만 담당한다. [Kotlin 상태 이관 결과](kotlin-state-migration-result.md)는 당시 실행 증거다. 각 릴리스의 검사·실행 버전·화면 확인은 해당 릴리스 기록으로 증명한다.
