# UI와 시나리오 결과 연결 명세

> **초기 디자인·정적 데모 이력.** 이 문서는 현재 구현·운영 서버의 상태를 나타내지 않습니다. [현행 저장소 문서](../../../README.md)를 먼저 사용하세요. 원문은 당시 판단의 근거로 보존합니다.

상태: **로컬 합성 표본 기준 계약 준비** · 2026-09-13. 이 문서는 현재 UI가 소비하는 값과 동작을 정리한 연결 초안입니다. 상현님 시나리오 구현, 실제 API 또는 장치 연결이 완료되었다는 의미가 아닙니다.

## 현재 데이터 경계

현재 `view-model.mjs`는 `getTerminalSnapshots(scenarioId)`를 호출해 단말·배송 결과 배열을 받고, 조회 필터와 선택 결과를 계산합니다. `app.mjs`의 배송 현황·단말 관제·고객 보기는 이 `viewModel(state)`의 같은 `selected` 결과를 표현합니다. UI는 ETA나 배송 상태를 계산하지 않습니다.

```text
getTerminalSnapshots(scenarioId) → viewModel(state) → terminals / visible / selected → 세 업무 화면
```

- 현재 공급자: `sample-data.mjs`의 동기 함수와 합성 데이터. 호출할 때마다 복제된 4개 결과를 반환합니다.
- 현재 입력: `scenarioId`. 지원하지 않는 ID는 오류를 발생시킵니다.
- 현재 조회: 검색어, 배송 상태, ETA 변경 여부를 결과 배열에 적용합니다. 원본 사건과 ETA 결과는 바꾸지 않습니다.
- 향후 공급자: 상현님 구현의 조회 결과 또는 확인된 외부 데이터 접근부. 전송 방식과 API 주소는 아직 정하지 않았습니다.

## UI가 사용하는 결과 필드

아래 이름과 값은 현재 로컬 표본에서 관찰한 형태입니다. 향후 최종 명칭이나 열거형으로 확정한 것이 아닙니다.

| 필드 | 현재 UI 의미와 주의점 |
|---|---|
| `id`, `vehicle`, `deliveryId`, `customer` | 단말·차량·배송·고객 별칭 식별. 현재의 1차량·1단말·1배송 연결은 합성 예시입니다. |
| `stage`, `status` | 사람이 읽는 배송 단계와 목록 필터용 상태. 현재 `preparing`, `in_transit`, `completed`가 있습니다. |
| `etaStatus` | ETA 의미 구분. 현재 `unknown`, `ready`, `stale`, `completed`를 사용하며 `unknown`과 `stale`을 정상 ETA로 바꾸지 않습니다. |
| `eta` | `{ start, end, updatedAt }` 시간 범위 또는 `null`. 단일 도착 시각으로 계산하거나 축약하지 않습니다. |
| `previousEta`, `changed`, `changeText`, `reason` | ETA 변경 전후와 표시 사유. UI는 공급받은 값을 비교해 보여줄 뿐 변경 폭을 다시 계산하지 않습니다. |
| `updatedAt` | 배송 결과가 마지막으로 갱신된 시각. |
| `snapshotTime` | 현재 조회 표본의 기준 시각. 갱신 실패에서는 `updatedAt`보다 늦을 수 있습니다. |
| `resultVersion` | 같은 조회 결과를 운영용·고객용 표현에서 대조하기 위한 버전 후보. 현재는 `sample:*` 표식이며 제품 버전 규칙은 미확정입니다. |
| `sequence` | 현재 계획 순서 또는 `null`. 미확정 값을 `0`으로 표시하지 않습니다. |
| `actualArrivalAt`, `completedAt` | 실제 도착 시각과 완료 처리 시각. 서로 대체하지 않으며 현재 완료 표본도 실제 도착은 미확인입니다. |
| `deviceConnection`, `deviceReceivedAt` | 실제 장치 연결·수신 근거. 현재 모든 표본이 `null`입니다. |
| `deviceNotice`, `customerNotice` | 알림 문구 표본 또는 `null`. 각 객체의 `receivedAt`은 실제 수신 증거이며 현재 모두 `null`입니다. 문구가 있어도 발송·전달·수신 완료로 표현하지 않습니다. |
| `events` | 사건 시각, 종류, 제목, 설명의 배열. UI는 시간순 사건 이력으로 표시하며 상태 전이를 실행하지 않습니다. |

## 현재 합성 결과 예시

아래 값은 `getTerminalSnapshots('traffic')[0]`에서 2026-09-13 직접 확인한 TMS-001 결과입니다. 연결에 필요한 핵심 필드를 골라 현재 소스 이름과 값을 유지했습니다.

```json
{
  "id": "TMS-001",
  "vehicle": "가상 차량 01",
  "deliveryId": "DEMO-001",
  "customer": "가상 식당 A",
  "stage": "배송 출발",
  "status": "in_transit",
  "etaStatus": "ready",
  "eta": {
    "start": "13:20",
    "end": "14:20",
    "updatedAt": "11:45"
  },
  "previousEta": {
    "start": "13:00",
    "end": "14:00",
    "updatedAt": "11:30"
  },
  "sequence": 5,
  "changed": true,
  "changeText": "20분 늦어짐",
  "reason": "교통 지연",
  "updatedAt": "11:45",
  "snapshotTime": "11:45",
  "resultVersion": "sample:traffic",
  "actualArrivalAt": null,
  "completedAt": null,
  "deviceConnection": null,
  "deviceReceivedAt": null,
  "deviceNotice": {
    "title": "도착 예정 시간이 변경되었습니다.",
    "body": "교통 지연 · 도착 예정 13:20 ~ 14:20 · 이전 안내보다 20분 늦어짐",
    "at": "11:45",
    "receivedAt": null
  },
  "customerNotice": {
    "title": "도착 예정 시간이 변경되었습니다.",
    "body": "교통 지연으로 오늘 13:20 ~ 14:20 도착 예정입니다. 이전 안내보다 20분 늦어질 예정입니다.",
    "at": "11:45",
    "receivedAt": null
  }
}
```

## 조회·선택·메뉴·초기화 계약

| 동작 | 현재 의미 |
|---|---|
| 검색 `query` | 단말 ID, 차량, 배송 ID, 고객 별칭을 대소문자 구분 없이 찾습니다. |
| 상태 `status` | `all` 또는 `status`의 정확한 값으로 거릅니다. `needs_check`는 `etaStatus`가 `unknown` 또는 `stale`인 결과를 뜻합니다. |
| 변경만 `changedOnly` | `changed === true`인 조회 결과만 남깁니다. 검색·상태 조건과 함께 적용합니다. |
| 선택 `selectedId` | 보이는 결과 안에서 같은 ID를 우선 선택합니다. 필터로 사라지면 첫 결과를 선택하고, 결과가 없으면 `null`입니다. |
| 메뉴 이동 | `#/deliveries`, `#/control`, `#/customer` 사이에서 현재 시나리오, 선택, 조회 조건을 유지합니다. 세 화면은 같은 `selected`를 사용합니다. |
| 시나리오 선택 | 선택한 시나리오 결과로 바꾸고 TMS-001을 선택하며 조회 조건을 초기화합니다. 현재 메뉴는 유지합니다. |
| 전체 초기화 | `departure`, TMS-001, 사건 이력 탭으로 돌아가고 조회 조건을 초기화합니다. 현재 메뉴는 유지합니다. 이전 시나리오의 변경 결과를 누적하지 않습니다. |

시나리오 팝업의 위치와 접힘 상태는 화면 조회 결과와 별도인 UI 상태입니다. 메뉴 이동이나 결과 초기화가 이를 다시 계산하지 않습니다.

## 향후 연결의 최소 변경 지점

향후 공급자가 정해지면 `view-model.mjs`의 데이터 공급 경계에서 `getTerminalSnapshots` 직접 호출을 교체하는 방향을 우선 검토합니다. 공급 방식이 동기 함수인지 HTTP 요청인지 아직 모르므로 구체 API 이름과 비동기 규약은 지금 확정하지 않습니다.

연결 후에도 다음 표현 계약은 유지합니다.

1. `viewModel`은 공급받은 결과에 조회 조건을 적용하고 `terminals`, `visible`, `selected`를 UI에 제공합니다.
2. 공통 ETA·상태·고객 카드가 같은 결과를 사용합니다. 화면별 계산 로직을 추가하지 않습니다.
3. 미확정, 오래된 ETA, 완료 시각, 실제 도착 시각, 알림 수신 여부를 구분합니다.
4. 공급자 오류나 처리 중 상태는 결과 상태와 별도로 전달해야 합니다. 현재 로컬 함수에는 해당 계약이 없습니다.
5. `resultVersion` 또는 합의한 동등 식별자로 세 업무 화면이 같은 결과를 표시하는지 확인합니다.

## 아직 정하지 않은 사항

- 최종 API 주소, 전송 방식, 인증, 오류·로딩 응답 형태
- 주문·배송·차량·TMS 단말의 실제 관계와 식별자 매핑
- ETA 상태, 갱신 주기, 시간대, 만료·재계산 정책
- 실제 장치 연결 상태와 수신 시각의 원천
- 알림 생성·발송·전달·수신의 구분과 고객 노출 정책
- 시나리오 입력, 동작 반영 결과, 초기화의 최종 호출 계약

이 항목들이 합의된 뒤 공급자 연결과 실제 통합 검증을 진행합니다. 현재 문서는 그 작업을 위한 UI 측 준비물입니다.
