# 시스템 아키텍처

이 문서는 기준 코드 `40387756a5c02d02af6ac134d4a2d5bfa1146bef`의 현재 구현을 설명한다. 목표 구조나 배포 완료 상태를 뜻하지 않는다. 상태 전이와 식별자는 [도메인과 상태](domain-and-state.md), HTTP 계약은 [API 참조](api-reference.md)를 따른다.

## 한눈에 보는 구조

```text
브라우저
  ├─ /combined/*  ── REST 조회/명령 ──┐
  ├─ /ui-layout/*  ── 정적 참조 UI    │
  └─ /scenario/*   ── WebSocket ──────┼─ Express 단일 프로세스
                                      │    ├─ 세션/초대: ACCESS_FILE JSON
                                      │    ├─ 날짜 원본: DISPATCH_DATA_DIR JSON·gzip
                                      │    ├─ 날짜 상태: 메모리 + 선택적 DISPATCH_STATE_DIR 체크포인트
                                      │    ├─ 자원 등록부: 선택적 RESOURCE_DATABASE SQLite
                                      │    └─ 레거시 시뮬레이션: 별도 메모리 엔진
                                      └─ 외부 주문·GPS·알림 공급자 연결 없음
```

서버 진입점은 [`createDemo`](../server.js)다. 한 Express/HTTP 프로세스가 인증, 정적 화면, 날짜별 REST API, 자원 API와 레거시 WebSocket을 함께 제공한다. 프로세스를 여러 개 띄우는 분산 상태 조정은 구현되어 있지 않다.

## 런타임 책임

| 영역 | 현재 책임과 상태 권위 | 코드 |
|---|---|---|
| HTTP 게이트웨이 | 보안 헤더, 로그인 강제, 라우팅, WebSocket 업그레이드 | [`createDemo`](../server.js) |
| 계정과 세션 | 초대 1회 사용, 비밀번호 해시, 세션 발급·만료·로그아웃 | [`createAccess`](../lib/access.js) |
| 날짜 원본 조회 | 매니페스트, 날짜별 주문, 권역, 누적 배송지의 검증된 파일 조회 | [`createDispatchDataRouter`](../lib/dispatch-data.js) |
| 날짜별 배차 집계 | 미배차·계산안·확정·수정안과 운행 상태를 하나의 날짜 aggregate로 관리 | [`createDispatchOperations`](../lib/dispatch-operations.mjs) |
| 확정 후 운행 상태 | 순서, 출발·도착·완료, 보류, 팁, 화면 내 고객 알림 | [`createSourceOperations`](../lib/source-operations.mjs) |
| 날짜 상태 API | 날짜별 직렬화, CAS, ETag/gzip, 체크포인트 저장, 최근 엔진 캐시 | [`createSourceOperationsRouter`](../lib/source-operations-router.js) |
| 배차 계산 | 선택 차량에 모든 주문을 완전 배정하는 동기 계산기 | [`calculateDispatch`](../lib/dispatch-calculator.js) |
| 자원 등록부 | 활성 차량과 지역 코드, SQLite 트랜잭션 및 별도 CAS revision | [`createResourceStore`](../lib/resource-store.js) |
| 통합 화면 클라이언트 | 날짜 원본 로드, 상태 polling, 명령 전송, 계산안·확정본 표시 | [`mountDatedDispatch`](../apps/combined/dated-dispatch.mjs), [`connectSourceOperations`](../apps/combined/source-client.mjs) |
| 레거시 시연 | 고정 경로 데이터를 쓰는 독립 메모리 시뮬레이션 | [`OperatingSimulation`](../lib/operating-simulation.js), [`/ws/simulation`](../server.js) |

## 주 데이터 흐름

### 날짜 원본을 조회한다

1. 브라우저가 `/api/dispatch-data/manifest`와 `/regions`를 읽는다.
2. 선택일의 `/days/{date}`를 읽어 주문·후보 차량·권역을 그린다.
3. `/days/{date}/state`를 2초 간격으로 조회한다. 클라이언트는 ETag를 보내고 서버는 변경이 없으면 `304`를 반환한다.
4. 원본 파일은 조회 중 수정하지 않는다. 허용 날짜는 매니페스트 목록으로 제한한다.

원본 어댑터는 현재 사전 생성된 JSON 파일이다. 생성 스크립트와 실제 외부 Meatbox 주문 API 사이의 인증, 서명, 변경·취소, 재시도 계약은 구현되어 있지 않다. 원본 포맷은 [`prepare-dispatch-data.py`](../scripts/prepare-dispatch-data.py)와 [`dated-dispatch-data.md`](dated-dispatch-data.md)에 기록되어 있다.

### 계산안을 확정하고 운행한다

1. `calculate_dispatch`가 선택 차량과 모든 주문을 계산기에 전달한다.
2. 서버는 주문 누락, 알 수 없는 차량, 동일 배송지 분할을 거부하고 계산안을 `draft`로 보관한다.
3. `publish_dispatch`가 최신 `draftVersion`을 확인하고 확정 운행 엔진을 생성한다.
4. 확정 후에만 배송원·고객용 `fleetDeliveries`가 채워지고 운행 명령을 받는다.
5. 모든 명령은 서버 `boot`와 날짜 aggregate의 `revision`을 비교한다. 동일 날짜 명령은 서버 안에서 순서대로 실행한다.
6. 체크포인트 디렉터리가 설정되어 있으면 후보 상태를 별도로 만든 뒤 파일 저장에 성공한 경우에만 메모리 상태를 교체한다.

체크포인트 파일은 정상 프로세스 재시작 복원을 위한 경계다. 임시 파일을 동기화한 뒤 원자적 이름 변경을 하지만 디렉터리 엔트리를 별도로 `fsync`하지 않으므로 갑작스러운 전원 손실에서 최신 변경까지 보장하지 않는다. `DISPATCH_STATE_DIR`가 없으면 상태는 프로세스 메모리에만 남는다.

### 자원 등록부를 관리한다

`RESOURCE_DATABASE`가 지정된 경우에만 `/api/resources`가 열린다. 활성 차량과 지역 코드를 SQLite에서 읽고, 모든 쓰기를 하나의 트랜잭션과 자원 전용 `revision`으로 보호한다. 같은 지역 코드를 여러 차량에 지정할 수 있다.

서버는 DB 파일을 자동 생성하지 않는다. 다만 기존 schema v1 DB를 처음 여는 시점에는 [`migrateV1`](../lib/resource-store.js)이 트랜잭션으로 schema v2로 바꾼다. 연결은 lazy이므로 최초 `GET /api/resources`도 이 마이그레이션을 일으킬 수 있다. 읽기 전용 점검으로 간주하면 안 된다.

## 디렉터리 경계

| 경로 | 의미 | 운영 판단 |
|---|---|---|
| [`server.js`](../server.js) | 프로세스 조립과 외부 경로 | 새 업무 규칙을 넣기보다 라우터를 조립하는 곳 |
| [`lib/`](../lib/) | 인증, 데이터 검증, 배차·운행 상태, 저장소 | 서버 측 계약과 상태 권위 |
| [`apps/combined/`](../apps/combined/) | 통합 운영·배송원·고객 화면 | 날짜별 REST 제품 경로. 화면 검사는 서버 권한 검사를 대신하지 않음 |
| [`apps/portal/`](../apps/portal/) | 로그인·등록 페이지 | 인증 UI만 담당 |
| [`workspaces/sanghyun-scenario/`](../workspaces/sanghyun-scenario/) | 레거시 시나리오 원본 | `/scenario/*` 참고 화면의 원본. 날짜별 상태 권위가 아님 |
| [`workspaces/jiin-ui/`](../workspaces/jiin-ui/) | UI 레이아웃 참조 | `/ui-layout/*` 참고 화면. 제품 상태를 소유하지 않음 |
| [`scripts/`](../scripts/) | 원본 변환·검증·관리 도구 | 온라인 요청 처리와 분리된 사전 준비 단계 |
| [`test/`](../test/) | 서버·도메인·통합 계약 | 상태 보존과 오류 경계의 회귀 근거 |
| `.runtime/` | Git 제외 런타임 입력·상태 | 저장소 문서나 소스에 포함되지 않으며 설치별로 별도 확인 필요 |

## 레거시와 날짜별 제품 경로

아래 비교는 날짜 자료가 연결된 `/combined/*` 기준이다. manifest가 404인 설치에서는 [simulation-client.mjs](../apps/combined/simulation-client.mjs)가 기존 WebSocket 시나리오로 전환할 수 있다. 다른 통신·손상 오류는 이 폴백 조건이 아니다.

| 구분 | `/scenario/*` | `/combined/*` |
|---|---|---|
| 입력 | 저장소의 고정 `route-data` | `DISPATCH_DATA_DIR`의 날짜별 파일 |
| 상태 엔진 | `OperatingSimulation` | 날짜마다 `createDispatchOperations` |
| 통신 | `/ws/simulation` WebSocket | `/api/dispatch-data/*` REST polling/명령 |
| 영속 상태 | 프로세스 메모리 | 메모리, 선택적 날짜별 체크포인트 |
| 용도 | 보존된 시나리오·참조 화면 | 현재 통합 제품 흐름 |

날짜별 모드의 두 엔진은 로그인 세션만 공유한다. 원본 미설치에 따른 합본 시나리오 폴백은 레거시 엔진을 사용한다. 배차, 운행 revision, 사건 이력과 고객 알림은 공유하지 않는다. `/scenario/driver.js`의 완료 동작은 통합 배송원 화면으로 이동하도록 게이트웨이가 응답을 치환하지만, 이것이 두 엔진을 합치지는 않는다.

## 현재 구현과 목표를 구분한다

| 주제 | 현재 구현 | 운영 전 필요한 계약 |
|---|---|---|
| 권한 | 로그인 여부만 검사하며 인증된 사용자는 같은 API 범위를 사용 | 운영자·배송원·고객 역할과 주문·차량 소유권을 서버에서 검사 |
| 배송 사진 | 명령의 `hasPhoto: true`와 브라우저 미리보기를 검사 | 업로드, 영구 저장, 증빙 ID와 주문·업로더 결합 |
| 고객 알림 | 상태 snapshot 안의 `고객 팝업` 기록 | FCM·문자 등 공급자 전송, outbox, 재시도, 기기 ACK |
| 주문 원본 | 사전 생성된 날짜별 파일 | 외부 원본 인증, 변경 순서, 중복 제거, 취소·재처리 계약 |
| 위치·ETA | 생성 위치와 화면 계산값이 포함될 수 있음 | 기기 GPS 출처·시각·정확도와 실제 ETA 입력 |
| 동시 실행 | 프로세스 내부 날짜별 큐와 파일 교체 | 다중 프로세스/호스트의 DB 트랜잭션 또는 단일 writer 보장 |
| 감사 | 사건 이력은 있으나 실행 계정과 변경 전후 전체 감사 계약이 없음 | 행위자·명령 ID·이전/이후 버전의 불변 감사 이력 |

이 표의 오른쪽 열은 권고 사항이며 현재 구현으로 읽으면 안 된다.
