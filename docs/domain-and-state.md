# 도메인과 상태 계약

날짜별 배차와 운행 상태의 의미, 식별자, 변경 조건을 정의한다. 외부 주문 공급자의 계약은 연동 시 별도로 확정한다.

## 상태의 집계 경계

날짜 하나가 하나의 배차 aggregate다. [`createDispatchOperations`](../lib/dispatch-operations.mjs)는 그 날짜의 원본 주문, 계산안, 확정 배차와 운행 상태를 함께 노출한다. 정상 산출물 계약상 API의 `{date}`와 원본 `day.date`는 일치해야 하며 매니페스트에 없는 날짜는 조회하지 않는다. 다만 현재 서버의 날짜 파일 로더는 URL 날짜와 파일 본문의 날짜가 같은지 직접 대조하지 않는다. 클라이언트는 응답 날짜를 확인하지만 서버 검증을 대신하지 못하므로, 자료 배치 시 파일명·본문 날짜 일치를 검증해야 한다. 서버의 이 검증 보강은 후속 과제다.

```text
원본 day(date, groups, orders)
        │
        ├─ dispatchOrders      운영자가 보는 원본+초안/확정 배정
        ├─ dispatchCandidates  원본 그룹에서 만든 후보 차량
        └─ fleetDeliveries     확정 후 배송원·고객이 보는 운행 주문
```

계산안은 `dispatchOrders`와 `dispatchPreview`에만 나타난다. 확정 전 `fleetDeliveries`는 비어 있다. 이 분리가 계산 결과를 기사 배차로 오인하지 않게 하는 핵심 계약이다.

## 주요 개념과 식별자

| 이름 | 현재 의미 | 수명과 주의점 |
|---|---|---|
| `date` | `YYYY-MM-DD` 운영 날짜 | URL, 원본, 체크포인트를 묶는 aggregate 키 |
| `sourceId` | CSV 날짜는 매니페스트 `source.csvSha256`, 미트박스 주문(API) 날짜는 `api-` + 적용된 활성 주문 `id:version` 줄의 SHA-256 | 체크포인트가 다른 원본에 붙는 것을 차단. 외부 주문 버전이나 이벤트 순서가 아님 |
| `order.id` | 준비 스크립트가 만든 날짜별 주문 ID | 주문·정렬·명령 참조. 회원 번호나 외부 공개 ID로 가정하지 않음 |
| `group.id` | 원본 배송기사 표기 그룹에서 만든 후보 ID | 현재 `vehicleId` 후보로 사용하지만 검증된 기사 계정·차량 자산 ID는 아님 |
| `vehicleId` | 계산안 또는 확정 운행에서 주문이 배정된 후보 ID | 기사 로그인과 연결되지 않음 |
| `assignmentUnitId` | 정규화한 `name + address`의 SHA-256 기반 내부 배송지 묶음 ID | 같은 묶음의 주문은 한 차량에 배정되고 경로에서 붙어 있어야 함. 상세주소는 이 해시에 포함되지 않음 |
| `boot` | 서버 프로세스 시작 때 만든 UUID | 재시작 이전 클라이언트의 명령을 차단. 저장·복원하지 않음 |
| `revision` | 날짜 aggregate의 외부 CAS 버전 | 성공한 모든 배차·운행 명령마다 1 증가. 초안 번호나 내부 운행 revision과 다름 |
| `draftVersion` | 계산안 또는 수정안 내용 버전 | 계산, 핀 재배차, 수정안 시작 때 증가. 전송 요청이 최신 초안을 가리키는지 확인 |
| `confirmedVersion` | 마지막 전송에 사용한 `draftVersion` | 확정본 번호. 운행 진행 명령으로는 바뀌지 않음 |
| 자원 `revision` | SQLite 자원 등록부 CAS 버전 | 날짜 aggregate `revision`과 완전히 별개 |

원본 주문은 현재 코드에서 `Order`, `DeliveryTask`, `Stop`으로 분리된 영속 엔티티가 아니다. `order` 객체가 원본 주문, 배송지 참조와 운행 표시 필드를 함께 운반한다. 운영 설계에서 이들을 분리하는 것은 권고할 수 있지만, 현행 모델처럼 문서화하면 안 된다.

## 배차 상태 기계

```text
unplanned
   │ calculate_dispatch
   ▼
 draft ── reassign ──► draft
   │ publish_dispatch(draftVersion)
   ▼
published ── begin_dispatch_revision ──► amending
   ▲                                      │  reassign
   │ discard_dispatch_revision            ├──────────► amending
   │                                      │ publish_dispatch(draftVersion)
   └──────────────────────────────────────┘
```

| 단계 | 보유 상태 | 허용되는 핵심 작업 |
|---|---|---|
| `unplanned` | 원본 주문과 후보만 있음 | 계산 |
| `draft` | `draftAssignments`, 후보, 계산안 버전 | 재계산, 배송지 묶음 재배정, 전송 |
| `published` | 확정 운행 엔진과 `confirmedVersion` | 운행 명령, 수정안 시작 |
| `amending` | 확정 운행 엔진과 분리된 수정용 `draftAssignments` | 보호되지 않은 배송지 재배정, 다시 전송, 수정 취소 |

### 계산

`calculate_dispatch`는 선택한 후보, 전체 원본 주문과 배송지 묶음을 동기 계산기에 넘긴다. 결과는 모든 주문을 정확히 한 번 배정해야 하고 선택하지 않은 차량을 사용할 수 없다. 동일 배송지 묶음이 여러 차량으로 갈라지면 전체 계산을 거부한다. 구현은 [`calculate`](../lib/dispatch-operations.mjs)와 [`calculateDispatch`](../lib/dispatch-calculator.js)에서 확인한다.

### 재배정

`reassign`에 주문 일부를 보내도 서버는 같은 `assignmentUnitId`의 주문 전체로 범위를 확장한다. 현재 또는 완료 상태인 주문이 하나라도 있는 배송지 묶음은 수정안에서 보호한다. 성공한 재배정은 `draftVersion`과 외부 `revision`을 각각 올리지만 확정 운행에는 아직 반영하지 않는다.

### 확정

`publish_dispatch`는 요청의 `draftVersion`과 현재 초안 버전을 비교하고 배송지 묶음·보호 주문을 다시 검증한다. 최초 확정은 새 운행 엔진을 만들고, 수정안 재전송은 기존 운행 체크포인트 위에 재배정을 적용한다. 검증을 모두 통과한 뒤에만 `phase=published`, `confirmedVersion=draftVersion`이 된다.

확정은 서버 snapshot을 바꾸는 동작이다. 기사 앱 전송, 푸시 수신, 기사 수락을 기록하는 동작은 아니다.

### 수정안

`begin_dispatch_revision`은 현재 확정 배정을 복제해 수정안을 만들고 `draftVersion`을 올린다. 이 동안 배송원·고객의 확정 운행은 계속 유지된다. `discard_dispatch_revision`은 수정안을 버리고 `draftVersion`을 `confirmedVersion`으로 되돌린다. 다시 전송할 때 운행 상태가 바뀌어 보호 배송지가 생겼다면 전송 시점에 다시 검증하여 전체 변경을 거부한다.

## 운행 상태

확정 후 [`createSourceOperations`](../lib/source-operations.mjs)가 차량별 경로와 다음 상태를 관리한다.

| 구분 | 값 |
|---|---|
| 주문 상태 | `pending`, `current`, `done`, `skipped` |
| 차량 phase | `idle`, `preparing`, `delivering`, `done` |
| 화면 단계 | `received`, `picking`, `ready`, `shipping`, `arrived`, `completed` |

`completed`는 `set_scenario`로 설정할 수 없다. `complete_stop`이 `hasPhoto: true`, 해당 배송지 묶음의 모든 필수 고객 요청 ID, 도착한 현재 배송지 상태를 함께 확인한 뒤 완료한다. 이 확인은 사진 파일이 저장되었다는 증거가 아니다.

같은 배송지 묶음은 출발, 도착, 완료, 보류, 팁과 재배정에서 함께 움직인다. 완료 뒤 다음 `pending` 배송지는 자동으로 `current`가 되지만 차량과 트럭 좌표는 완료 지점에 남기고 다음 목적지만 지정한다.

`send_customer_notice`가 만드는 알림은 snapshot 안의 기록이며 `channel: "고객 팝업"`, `status: "기록"`이다. 외부 발송 성공을 뜻하지 않는다.

## 기사 앱 이벤트의 번역

기사 앱 이벤트는 새 상태 기계가 아니라 위 운행 명령으로 번역한다. `eventId`가 날짜 명령의 `requestId`다. 한 이벤트의 명령은 후보 plan 위에서 모두 적용한 뒤 한 번에 저장한다. 중간에 실패하면 아무것도 남지 않는다.

| 이벤트 | 번역 |
|---|---|
| `departed` | (`stopOrder`가 있고 현재 순서와 다르면 `set_route_order`) → `start_route` |
| `zone_entered` | 명령 없음. ETA가 저장된 차량은 위치를 필수로 받아 권역 폴리곤 포함을 검증하고(밖이면 `422`) 남은 배송지 ETA를 다시 계산한다 |
| `stop_completed`, `stop_partially_completed` | (도착 전이면 `arrive_stop`) → `complete_stop` |
| `stop_failed` | (도착 전이면 `arrive_stop`) → `skip_stop` |
| `route_reordered` | `set_route_order`. phase가 `done`이거나 `pending`이 아닌(현재·완료·보류) 배송지의 자리가 달라지면 번역 전에 `ROUTE_LOCKED`. 출발 후 대기 배송지끼리의 변경은 허용되고 ETA를 다시 계산한다 |

- `skip_stop`은 이 번역을 위해 추가한 운행 명령이다. 도착한 현재 배송지 묶음을 `skipped`로 닫고 다음 대기 배송지를 `current`로 만든다. 사건 이력에는 `toggle_skip` 보류로 남는다. 날짜 명령 HTTP 경로는 받지 않는다.
- `skipped`만 남은 차량 경로는 `current`·`pending`이 없으면 phase가 `done`이 된다. 완료 판정이 `done`만 세던 것을 같이 고쳤다.
- 저장된 결과는 이벤트 응답(`accepted`, `receivedAt`, `stop`, `next`)이며 날짜 체크포인트의 `commandResults`에 같은 쓰기로 들어간다. 날짜 상태 전체가 아니다.
- ETA: 위 번역의 `departed`가 성공하면 같은 쓰기로 차량 ETA가 저장된다. 그 뒤 `stop_*`·`zone_entered`·출발 후 `route_reordered`가 성공하면 남은 배송지 ETA를 같은 쓰기로 다시 계산해 덮어쓴다(규칙과 임계는 [API 참조](api-reference.md#도착-예정-시각-eta)). 출발 시각은 `occurredAt`(수신 시각과 5분 넘게 다르면 수신 시각), 출발 위치는 이벤트 `location`이나 최근 위치 샘플이다. 계산 모델은 [API 참조](api-reference.md#도착-예정-시각-eta)에 있다.
- 이벤트가 주문 상태를 바꾸면 미트박스로 보낼 배송 상태 메시지가 같은 쓰기로 체크포인트 `outbox`에 들어간다(아래). `stop_completed`→`delivered`, `stop_partially_completed`→`partially_delivered`, `stop_failed`→`failed`, `departed`→`departed`. `zone_entered`·`route_reordered`는 배송 상태를 보내지 않는다. `departed`는 차량 ETA 메시지(`kind: "eta"`) 1건도 더 남기고, 재산출은 새 ETA가 마지막으로 보낸 ETA와 임계 이상 벌어질 때만(`route_reordered`는 항상) 남긴다. 미전송 ETA 메시지는 새 메시지로 교체된다(아래 ETA).

### 기사 상태 파일의 소유

기사 앱이 보낸 부가 기록은 날짜 체크포인트가 아니라 `DriverStore`의 날짜별 파일 `driver-{date}.json`이 소유한다. 운행 상태(배송지 `status`, 완료·미배송)는 체크포인트가 유일한 원본이다.

| 필드 | 내용 | 한도 |
|---|---|---|
| `events` | 이벤트 기록. `eventId`로 한 번만 기록. 사유 코드·특이사항·사진 ID·스캔 코드·품목·출발 시각·위치·`zoneId` | 최근 3000건, 파일 8 MiB |
| `locations` | 차량별 위치 샘플 | 차량당 최근 120건 |
| `locationVersion` | 위치 배치를 받을 때마다 1 증가. 날짜 상태 ETag에 반영 | |

- 이벤트 기록은 운행 명령이 성공한 뒤에 쓴다. 기록 쓰기가 실패하면 요청은 `503`이지만 상태는 이미 반영됐다. 같은 `eventId`를 다시 보내면 상태는 건드리지 않고 기록만 채운다.
- 가장 최근 위치는 날짜 상태를 만들 때 합성 위치 위에 덮어 보여 준다(`location.source: "driver"`). 체크포인트에는 쓰지 않는다.
- 사진 파일은 상태 디렉터리 `photos/{date}/`가 소유한다. 사진 ID는 서버가 만든 UUID이고, 이벤트는 ID로만 참조한다.

### 온도 시계열 파일의 소유

온도 측정값은 날짜 체크포인트도 `driver-{date}.json`도 아닌 `{state-dir}/telemetry/{vehicleId}/{yyyy-MM-dd}.jsonl`이 소유한다. 시계열이고 날짜 aggregate와 수명이 다르며 보관 기한이 없기 때문이다.

- 한 줄이 측정 1건이다: `t`(측정 시각 `+09:00`), `c`(섭씨), `s`(센서 ID), `k`(칸 `frozen`·`chilled`, 선택), `r`(수신 epoch ms). 파일은 덧붙이기만 한다.
- 날짜는 측정 시각의 서울 날짜다. 늦게 도착한 측정(단말 재전송)은 자기 날짜 파일에 들어간다.
- 같은 센서·같은 초는 한 번만 남는다. 프로세스는 파일별 키 집합을 메모리에 두고, 파일 크기가 자기가 쓴 값과 다르면(다른 프로세스가 썼으면) 다시 읽는다.
- 차량별 최신 값은 메모리에 있고 시작할 때 각 차량의 마지막 파일에서 복원한다. 오늘 날짜 snapshot이 `vehicleStates[v].temperature`로 덧씌워 보여 주고(`DriverLocationOverlay`와 같은 방식, 체크포인트에는 쓰지 않음) 기사 경로 조회가 같은 값을 읽는다. 이탈 판정 상태(`outOfRange`)는 메모리에만 있다.
- 허용 범위는 `telemetry/ranges.json`(차량별 `kind` 또는 `min`·`max`)이 가진다. **임시 위치다.** 자원 등록부 `vehicles` 필드로 옮길 예정이며, 옮기면 이 파일과 `MEATBOX_TELEMETRY_DEFAULT_KIND`는 없어진다.
- 미트박스로 보낼 온도 메시지는 차량별 `outbox.json`이 소유한다: `{cursor: {날짜: 바이트 위치}, outbox: [배송 상태 송신함과 같은 항목]}`. 위치는 "그 날짜 파일에서 여기까지는 메시지에 담았다"는 뜻이고 측정 시각이 아니라 도착 순서를 따른다. 새 메시지와 앞당겨진 위치는 한 번의 원자적 파일 교체로 같이 쓴다(체크포인트가 상태·결과·송신함을 한 번에 쓰는 것과 같은 이유). 위치는 최근 8일 파일만 갖는다. 항목의 ID·재시도·보존 규칙은 날짜 송신함과 같고 `orderId` 자리에 `vehicleId`가 들어간다. 날짜 체크포인트는 온도 메시지를 모른다.
- `telemetry/.telemetry.lock`이 쓰기를 직렬화한다. `DriverFileLock`을 같은 방식으로 쓴다.

## 미트박스가 보낸 주문(API 원본)

날짜 원본은 준비된 CSV 묶음이거나 미트박스가 `POST /api/meatbox/orders`로 보낸 주문이다. 한 날짜의 원본은 하나다. 매니페스트에 있는 날짜로 주문이 오면 `409 SOURCE_CONFLICT`이고, 두 원본이 함께 있는 날짜는 `DISPATCH_SOURCE_CONFLICT`로 닫는다. 어느 쪽도 조용히 고르지 않는다.

수신 파일(`{state-dir}/inbound/{date}.json`)은 주문마다 `received`(마지막으로 받은 version·본문 해시·status)와 `applied`(배차가 보는 version·본문)를 따로 둔다. 날짜 JSON과 `sourceId`는 `applied`의 활성 주문만으로 만든다. 같은 적용 집합은 같은 `sourceId`다.

| 날짜 상태 | 더 높은 version이 오면 |
|---|---|
| `unplanned` | 적용한다. 신규는 추가, 변경은 교체, 취소는 제외. `sourceId`가 바뀐다 |
| `draft` | 적용하고 계산안을 버린다(체크포인트 삭제 → 수신 파일 쓰기). 경고 `DRAFT_RESET_BY_INBOUND`(주문 id·version·시각)를 남기고 응답은 `draftReset: true`다. 적용 집합이 그대로면(처음 보는 주문의 취소) 버리지 않는다 |
| `published`·`amending` | 적용하지 않는다. `received`만 갱신하고 경고를 남기며 운영 알림(`meatbox-inbound`)을 보낸다. 변경 `ORDER_CHANGED_AFTER_DISPATCH`, 취소 `ORDER_CANCELLED_AFTER_DISPATCH`, 처음 보는 활성 주문 `ORDER_ADDED_AFTER_DISPATCH` |
| 해당 주문이 `done` | 위와 같고 코드는 `ORDER_CHANGED_AFTER_COMPLETION`이다(취소 포함) |

- 확정 뒤에는 `applied`가 바뀌지 않아 `sourceId`와 체크포인트가 그대로다. 확정·진행·완료 기록은 수신으로 바뀌지 않는다. 보류된 변경을 반영하는 운영자 경로는 아직 없다([다음 기능 계획](next-feature-delivery-plan.md) F11).
- 더 낮은 version은 무시하고, 같은 version·같은 본문은 중복이며, 같은 version·다른 본문은 `409 ORDER_VERSION_CONFLICT`다. 판정은 적용 여부와 무관하게 마지막으로 받은 version 기준이다.
- 계산안을 버릴 때의 순서는 체크포인트 삭제가 먼저다. 삭제 뒤 쓰기가 실패하면 이전 주문에 계산안만 없는 상태이고 송신자가 재시도한다. 파일을 먼저 쓰면 크래시 사이에 체크포인트가 사라진 원본을 가리켜 `DISPATCH_STATE_SOURCE_MISMATCH`가 된다.
- 경고는 snapshot `sourceData.inbound`(`kind`, `stamp`, `received`, `applied`, 최근 50건 `warnings[]`)에 나온다. CSV 날짜 snapshot에는 이 필드가 없다. `stamp`는 수신 파일이 바뀔 때마다 오르고 날짜 상태 ETag에 반영된다.
- 후보 차량은 합성 그룹 `api-g01`…이다(`MEATBOX_INBOUND_GROUP_COUNT`, 기본 8). 실제 차량이 아니며 다른 합성 후보와 같이 미검증 후보로 표시한다. 모든 주문의 초기 `groupId`는 첫 그룹이고 계산이 다시 배정한다.
- 좌표가 없는 주문은 `coordinates: null`로 들어가(웹 포크가 필드 자체를 요구한다) 박스 수 균형으로만 배정한다. 모든 주문의 `zoneIds`는 빈 배열이다. 주소 정제·좌표화는 하지 않는다.
- 단일 writer 가정은 체크포인트와 같다. 이 수신 파일에도 프로세스 간 잠금이 없다.

## 날짜의 의미

현재 기준일은 저장된 매니페스트 기본일이 아니라 서버 시각을 `Asia/Seoul`로 변환해 매 요청 시 계산한다. 다음 규칙을 적용한다.

- `date < today`: 조회 전용. 배차와 운행 명령을 모두 `DATE_READ_ONLY`로 거부한다.
- `date === today`: 변경 가능.
- `date > today`: 현재 구현에서는 변경 가능.
- 체크포인트의 `operatingDate`: 체크포인트가 처음 만들어질 때의 기준일 기록이다. 복원 후 읽기 전용 판정은 현재 서울 날짜로 다시 계산한다.

자정이 지나 선택일이 과거가 되면 ETag의 `today` 구성도 바뀌며, 기존 계산안은 보존하되 전송·변경은 거부한다.

## 동시성 계약

요청 ID가 있는 명령은 먼저 저장된 결과를 조회한다. 같은 `(date, requestId)`가 이미 성공했으면 아래 세 겹을 건너뛰고 처음 응답을 돌려준다. 응답을 잃은 재전송과 서버 재시작 뒤 재전송이 `REVISION_CONFLICT`·`BOOT_MISMATCH`로 거절되지 않게 하기 위해서다. 요청 ID 조회는 CAS보다 먼저다.

명령은 세 겹으로 오래된 쓰기를 막는다.

1. `expectedBoot`: 서버 재시작 이전 상태면 `BOOT_MISMATCH`.
2. `expectedRevision`: 같은 날짜에 다른 명령이 먼저 성공했으면 `REVISION_CONFLICT`.
3. `draftVersion`: 최신 계산안이 아니면 `DRAFT_CONFLICT`.

[`createSourceOperationsRouter`](../lib/source-operations-router.js)는 같은 날짜 명령을 프로세스 내부 큐로 직렬화한다. 각 명령은 현재 체크포인트에서 후보 엔진을 만들고 명령을 적용한 뒤, 선택적 파일 저장까지 성공해야 활성 엔진을 교체한다. 저장 실패 시 기존 메모리 revision은 유지된다.

이 보장은 한 Node 프로세스 범위다. 공유 상태 디렉터리를 여러 프로세스가 동시에 쓰는 잠금이나 합의는 없다.

## 체크포인트

외부 체크포인트 schema v2는 원본 전문을 복제하지 않고 다음 포인터와 변경 상태를 보존한다.

- `date`, `sourceId`, 생성 당시 `operatingDate`
- 외부 `revision`, `phase`, `draftVersion`, `confirmedVersion`
- `candidateIds`, `draftAssignments`
- `confirmedEngineCheckpoint`
- 선택 `commandResults`: 요청 ID별 `requestId`, 본문 `hash`, `savedAt`, 처음 `response`. 없으면 결과 없음이다. 같은 파일 쓰기로 저장해 상태와 결과가 따로 남지 않는다. schema 버전은 올리지 않았다. 이 필드가 없는 기존 v2 파일을 그대로 복원하고, 요청 ID 없는 명령은 이 필드를 쓰지 않아 파일이 이전과 같다.

- 선택 `outbox`: 미트박스로 보낼 메시지 목록. 항목은 `messageId`(`{date}-{revision}-{orderId}`), `kind`(`delivery-status`), `orderId`, 본문 `body`, `attempts`, `createdAt`, `nextAttemptAt`, `sentAt`, `failedAt`, `lastStatus`(시각은 epoch ms). 운행 명령이 성공해 체크포인트를 쓸 때 같은 파일 쓰기로 추가되므로, 상태만 바뀌고 메시지가 없거나 메시지만 있고 상태가 안 바뀐 경우가 없다. 저장이 실패하면 둘 다 남지 않는다. 같은 `eventId` 재전송은 저장된 결과를 돌려주고 항목을 만들지 않는다. 발송기는 시도 결과(`attempts`·`nextAttemptAt`·`sentAt`·`failedAt`)만 같은 방식으로 고쳐 쓴다. 쓰기 전에 파일의 `revision`이 메모리와 다르면(슬롯 전환 중 오래된 프로세스) 쓰지 않고 다시 읽는다. 전송 완료·거절 항목은 24시간, 최대 1000건 남기고 미전송 항목은 지우지 않는다. 단 같은 차량의 새 ETA 메시지가 들어오면 미전송 ETA 메시지는 새 것으로 교체된다. 이 필드가 없는 기존 v2 파일을 그대로 복원하고 schema 버전은 올리지 않았다. Node 엔진은 이 필드를 모른다. `kind`는 `delivery-status` 또는 `eta`다. ETA 항목의 `orderId`는 `eta-{vehicleId}`(차량 하나의 ETA 메시지가 순서대로 나가는 키), `messageId`는 출발이 `{date}-{revision}-eta-{vehicleId}`, 재산출이 뒤에 `-r{n}`을 붙인 값이다.

- 선택 `etas`: 차량별 최신 도착 예정 시각 `{vehicleId: {computedAt, reason, departedAt, departureTimeSource, recomputes, reported:[{stopId, eta}], stops:[{stopId, sequence, eta, estimated, actualAt?}]}}`. **ETA의 소유자는 날짜 체크포인트의 이 필드다.** 운행 엔진(`OperationalState`)은 모른다. `departed` 명령 묶음이 같은 파일 쓰기로 `etas`와 ETA 메시지를 함께 넣으므로, ETA만 있고 출발이 없거나 그 반대인 경우가 없다. 공개 상태를 만들 때 `vehicleStates[vehicleId].eta`로 덧씌우고 기사 조회가 이를 읽는다. 재시작해도 파일에서 복원한다. 이 필드가 없는 기존 v2 파일을 그대로 복원하고 schema 버전은 올리지 않았다. 출발이 처음 쓰고, 완료·미배송·권역 진입·출발 후 순서 변경이 같은 차량 항목을 덮어쓴다. 닫힌 배송지의 항목은 이전 `eta`를 남기고 `actualAt`을 더한다. `recomputes`는 재산출 횟수(출발은 0), `reported`는 마지막으로 미트박스에 보낸 열린 배송지 ETA다(`recomputes`·`reported`·`actualAt`이 없는 기존 파일도 복원하며 첫 재산출에서 메시지를 남긴다). ETA 메시지의 `messageId`는 출발이 `{date}-{revision}-eta-{vehicleId}`, 재산출이 뒤에 `-r{recomputes}`를 붙인 값이다.

체크포인트·기사 상태·사진·수신 주문·온도 시계열·자원 등록부는 계약 종료 때 한 아카이브로 내보낼 수 있다. 내보내기는 읽기만 하며 상태를 바꾸지 않는다. 형식은 [내보내기 형식](data-export-format.md)이다.

확정 엔진의 내부 체크포인트는 schema v1이며 변경된 경로·주문·차량 상태, 사건과 화면 내 알림만 저장한다. schema v2 안의 `confirmedEngineCheckpoint`로 포함된다. `createDispatchOperations`에 직접 전달한 변경 이력 있는 schema v1 체크포인트는 확정된 레거시 상태로 받아 다음 내보내기에서 v2 외피로 감싼다. HTTP 라우터의 디스크 로더는 schema v2 파일만 허용하므로 schema v1 파일을 `DISPATCH_STATE_DIR`에 그대로 놓으면 복원하지 않고 `DISPATCH_STATE_INVALID`로 닫힌다.

`presentationContentVersion`은 확정 엔진 체크포인트 안에 있다. 값 `0`은 기존 확정 배차에 합성 표현 콘텐츠를 소급하지 않으며, `1`은 현재 표현 기본값을 허용한다. 그 밖의 값은 복원을 거부한다.

원본 `sourceId`, 날짜, 주문·차량 구성 또는 체크포인트 구조가 맞지 않으면 fail closed 한다. 체크포인트가 손상됐을 때 새 미배차 상태로 조용히 시작하지 않는다.

## 화면별로 보이는 상태

| 시점 | 운영자 | 배송원·고객 |
|---|---|---|
| 미배차 | 원본 주문과 후보 | 고객은 배차 대기 표현, 배송원 확정 경로 없음 |
| 계산안 | `dispatchOrders`, `dispatchPreview` | 확정 경로 없음 |
| 확정 | 확정 배정과 운행 상태 | `fleetDeliveries` 기반 경로·진행 상태 |
| 수정 중 | 수정안과 확정본을 구분 | 기존 확정본 유지 |
| 재전송 | 새 확정 배정 | 새 snapshot 조회 후 반영 |

브라우저 링크의 `date`, `id`, `vehicleId`는 선택 문맥일 뿐 권한 증명이 아니다. 서버는 현재 로그인 여부만 검사하므로 실사용 전에 principal과 주문·차량의 소유 관계를 서버 계약으로 추가해야 한다.
