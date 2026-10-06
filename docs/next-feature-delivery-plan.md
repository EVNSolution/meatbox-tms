# 다음 기능 개발과 커밋·PR 계획

2026-10-06, Asia/Seoul. **계획 상태이며 기능 구현은 시작하지 않았다.** 기준은 PR #40의 `510cfe4e53e6164e1953b58eba971638f9ad6bdf`다. UI·Kotlin 이관 완료와 실제 업무 연동 완료를 구분한다.

사용자는 기능 단위 구현과 명확한 커밋·PR 경계를 요청했다. 실제 차량·기사 명부와 미트박스 주문 연동 명세는 **아직 확보하지 않았다**고 확인했다. 아래 F01 등의 번호는 계획 ID다. GitHub PR 번호는 생성 결과를 기록한다.

## 이번 목표와 고정 조건

첫 업무 목표는 **운영자가 검증된 차량과 주문을 연결하고, 배차를 계산·확정하며, 재시작과 재시도 후에도 결과를 확인하는 흐름**이다. 자료가 없는 동안 착수 가능한 기반 기능과 계약 입력이 필요한 기능을 나눈다.

- 프런트는 `apps/web/` 하나, 서버는 `services/api/`의 Kotlin/Spring을 유지한다.
- TEST 서버 한 대와 단일 Kotlin 업무 writer를 유지한다. QA·운영 서버 생성은 별도 단위다.
- 기존 주문, 초안, 확정·진행·완료 기록과 자원 등록부를 보존한다.
- 계정, 주문 그룹, 차량, 실제 기사 신원은 서로 다른 식별자다. 표시 이름이나 배열 위치로 연결하지 않는다.
- 공급 계약 없이 API 필드, 취소 의미, 역할, 단말 방식이나 알림 공급자를 확정하지 않는다.
- 기능에 필요한 저장 계약을 먼저 결정한다. 새 DB·브로커·다중 인스턴스 자체를 목표로 삼지 않는다.

## 현재 코드에서 확인한 선행 문제

| 확인한 사실 | 다음 기능에 미치는 영향 | 근거 |
| --- | --- | --- |
| 날짜의 기사 표기 그룹으로 번호판과 차량 기준 위치를 합성한다. 계획에서는 `live=true`도 부여한다. | 표시·이름이 실제 차량이나 GPS의 증거가 되지 않는다. 합성 정보 사용을 먼저 차단한다. | [DispatchFleet](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/DispatchFleet.kt), [DispatchPlan](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/DispatchPlan.kt) |
| 기존 자원 인수 도구도 합성 fleet를 사용한다. SQLite에 저장됐다는 사실만으로 실제 번호판이 검증되지 않는다. | 기존 등록 자료의 출처를 보존하고 실제 명부로 자동 승격하지 않는다. | [자원 인수 도구](../scripts/import-resource-catalog.mjs), [기존 저장 모델](../lib/resource-store.js) |
| 자원 등록부와 날짜별 배차 후보가 연결되지 않았다. 차량 생성·기사 등록 API도 없다. | 실제 차량 등록과 명시적 후보 연결을 별도 기능으로 구현한다. | [DispatchConfiguration](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/DispatchConfiguration.kt), [ResourceController](../services/api/src/main/kotlin/com/evnsolution/meatbox/resources/ResourceController.kt) |
| 날짜 상태는 전체 CSV 해시를 source ID로 쓰며 warm cache는 날짜의 유효한 내용 변경을 구분하지 않는다. | 원본 버전 변경을 기존 배차 상태와 대조해야 한다. | [DispatchStore](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/DispatchStore.kt) |
| 명령은 CAS로 충돌을 검사하지만 처리 결과를 요청 ID로 영속 조회하지 않는다. | 응답 유실 후 성공 여부를 확정할 수 없다. | [DispatchController](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/DispatchController.kt), [source-client](../apps/web/combined/source-client.mjs) |
| 업무 인가는 로그인 여부에 한정된다. | 실제 외부 사용자에게 자료를 제공하기 전에 테넌트·소속·역할 권한을 구현해야 한다. | [SessionVerifier](../services/api/src/main/kotlin/com/evnsolution/meatbox/auth/SessionVerifier.kt), [업무 필터](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/DispatchSessionFilter.kt) |

위 내용은 코드 확인 결과다. 아직 실행 재현이나 수정 완료를 뜻하지 않는다. F01·F02에서 재현부터 작성한다. 과거 UI 이관과 golden 일치는 당시 계약의 호환 증거이며 실제 차량·기사 연결의 증거가 아니다.

## 기능·PR 경계

각 행은 하나의 기능 PR이다. 서버, API client, 관련 UI와 회귀 검사를 함께 완성한다. 큰 기능을 프런트 PR·백엔드 PR로만 나눠 연결되지 않은 상태를 완료로 처리하지 않는다.

| ID | 사용자 또는 운영 결과 | 선행 조건 | 상태 |
| --- | --- | --- | --- |
| F01 | 미검증 번호판·차량 위치를 실제 정보로 보거나 사용하지 않는다. | 현재 코드와 보존 fixture | 착수 가능 |
| F02 | 원본 내용이 바뀌면 기존 배차를 조용히 재사용하지 않는다. | 기존 버전·checkpoint 이행 방식 결정 | 설계·재현 가능 |
| F03 | 같은 저장소에 두 writer가 동작하지 않으며 저장·복구 결과가 명확하다. | 단일 writer 유지, 파일 시스템 검증 | 착수 가능 |
| F04 | 응답이 유실돼도 명령 결과를 확인하고 같은 변경을 중복 적용하지 않는다. | F02·F03, 결과·감사 저장 계약 | 설계 가능 |
| F05 | 다른 회사·소속의 주문·차량·상태에 접근하지 못한다. | 테넌트 의미·계정 소속·기존 계정 이행표 | 계약 입력 필요 |
| F06 | 승인된 역할만 조회·계산·확정·자원 변경을 수행한다. | F05, 역할별 읽기·쓰기 권한표 | 계약 입력 필요 |
| F07 | 운영자가 실제 명부 근거로 차량을 등록·조회·변경한다. | F05·F06, 명부 형식·차량 식별·인수 방식 | 명부 미확보 |
| F08 | 원본 주문 그룹을 등록 차량에 명시적으로 연결해 계산·확정한다. | F04·F07, 매핑·합배·분할 정책 | 계약 입력 필요 |
| F09 | 받은 주문 자료의 버전·오류·수량·변경을 적용 전에 확인한다. | F05·F06, 공식 파일/API 인수 계약 | 명세 미확보 |
| F10 | 검증한 최초 주문 후보를 기존 배차가 없는 범위에 적용한다. | F02·F04·F08·F09, 원자적 적용·복구 계약 | 명세 미확보 |
| F11 | 기존 배차의 주문 변경·취소·재배차를 정책에 맞게 반영한다. | F10, 초안·확정·진행·완료 보호 정책 | 명세 미확보 |

F01–F04는 외부 자료를 기다리는 동안 진행할 수 있다. F05 이후는 필요한 계약을 먼저 기록한다. TEST에서 합성 명부로 회귀를 확인한 결과는 실제 차량 인수 성공으로 표시하지 않는다.

## PR별 커밋과 완료 조건

커밋 제목은 변경 이유를 나타낸다. 아래 제목은 계획이며 실제 범위가 바뀌면 함께 수정한다. 코드와 그 코드의 회귀 검사는 같은 목적 커밋에 둔다. 별도 `Test:` 커밋은 독립적인 통합 검증 도구를 추가할 때 사용한다. 실제 이행 절차·운영 문서는 해당 기능 PR 안에서 갱신한다.

### F01 — 차량 정보의 출처를 정확하게 표시

- C1 `Fix: Prevent generated fleet identities from appearing as verified data`
  - 합성 신원·위치의 공개 표현을 제어한다. 기사 표기 그룹과 실제 차량을 구분한다. 내부 그룹 ID·주문 참조와 schema 1/2 복원 계약은 보존한다.
  - 기존 checkpoint와 자원 인수 자료에서도 출처를 식별한다. 조회로 상태를 다시 저장하지 않는다. `vehicle`·`fleetVehicles`·`truck`·`vehicleStates`와 SQLite 자원 조회에 같은 원칙을 적용한다.
  - 복원에 필요한 내부 좌표·factory의 즉시 삭제는 범위에 넣지 않는다. 실제 후보 생성 교체는 F08에서 수행한다.
- C2 `Fix: Keep operational screens clear when fleet identity is unverified`
  - 배차·관제·자원 화면과 지도에서 실제 번호판·GPS로 오인되는 표시를 제거한다. 미확인 수량과 실제 0을 구분한다.
  - 카드·주문·이력 조회는 유지한다. 미검증 후보의 최초 확정·수정안 재확정을 서버와 UI에서 거부한다.
- **완료 조건:** 오늘·빈 날짜·기존 확정 이력·등록부에서 합성 번호판과 위치가 실제 정보로 노출되지 않는다. 정상 원본 주문 수량과 저장된 이력은 보존된다. 조회·거부 경로에서 상태 파일 바이트를 유지한다. 직접 명령으로 UI 제한을 우회하지 못한다.
- **검증:** 원본 계약과 의도적으로 달라지는 부분을 명시한다. 원래 Node golden 결과를 고쳐 차이를 숨기지 않는다. 실제 JAR과 인증 브라우저에서 거부·조회·지도 표시를 확인한다.

F01의 명령 범위는 다음과 같다. 현재 날짜·boot/revision CAS 등 기존 검사는 모두 유지한다. 명령의 내부 계산 시험은 격리 fixture로 수행하며 TEST 업무 서버에 차단 우회 설정을 추가하지 않는다.

| 명령 | F01에서 허용하는 결과 |
| --- | --- |
| `calculate_dispatch` | 원본 그룹의 미검증 초안 계산. 결과를 실제 차량 배정·기사 전달로 표시하지 않음 |
| `reassign` | 초안에서 원본 그룹 간 배정 변경. 확정 기록은 변경하지 않음 |
| `begin_dispatch_revision` | 기존 확정본을 보존하며 수정안을 시작. 미검증 수정안의 확정은 거부 |
| `discard_dispatch_revision` | 수정안 취소 후 기존 확정본 유지 |
| `publish_dispatch` | 후보의 실제 차량 신원·연결이 입증되지 않으면 최초 확정·재확정 모두 거부 |
| `set_route_order` | 차량 신원·연결이 입증되지 않은 확정본은 변경 거부. 기존 이력 조회 유지 |

명부가 없는 현재 TEST에서 F01 이후 신규 확정은 사용할 수 없다. 확정 가능 조건은 F07·F08에서 실제 자료로 충족한다.

### F02 — 원본 내용 변경으로부터 배차 보호

- C1 `Fix: Keep dispatch plans tied to the exact source version`
  - 날짜별 내용 버전과 캐시·checkpoint의 대응을 검사한다. 전체 CSV 해시가 같아도 내용 변경을 구분한다.
- C2 `Fix: Preserve legacy dispatch state during source version adoption`
  - 원본 지문이 없는 기존 v2의 이행·거부·복구 절차를 구현한다. 최초 조회에서 현재 파일을 원래 원본으로 자동 인정하지 않는다.
- **범위:** 기존 v2는 원본 전체를 보관하지 않는 sparse checkpoint다. 대응 원본이 입증되지 않으면 현재 파일로 과거 상태를 재구성하지 않는다. 원본·checkpoint를 보존하고 원본 확인 필요 상태를 표시한다. 변경 주문의 업무 적용은 F10·F11에서 수행한다.
- **완료 조건:** cold/warm cache·재시작에서 원본 변경을 감지한다. 대응 근거가 없으면 변경 명령을 거부하고 기존 상태를 보존한다. 정상 원본의 바이트·ETag와 기존 날짜 경계를 유지한다.
- **검증:** 같은 CSV 해시·같은 날짜의 수량·주소·그룹·좌표 변경, 이전 checkpoint, 파일/gzip 불일치와 재시작·복구를 재현한다. checkpoint 삭제·캐시 초기화·현재 원본 자동 채택으로 우회하지 않는다. 이행 후보는 격리 경로에서 대조하고 TEST 업무 파일을 임의 재작성하지 않는다.

### F03 — 단일 writer와 저장·복구 보호

- C1 `Fix: Prevent concurrent API writers from sharing dispatch state`
  - 선택한 업무 저장 경계의 프로세스 간 잠금을 적용한다. 배포 호스트 lock과 업무 writer lock을 구분한다.
  - 같은 실제 저장 경로의 잠금을 readiness 이전에 획득하고 프로세스 수명 동안 유지한다. Node writer의 중지 또는 같은 배제 계약도 확인한다.
- C2 `Fix: Make acknowledged dispatch writes survive the agreed failure boundary`
  - 파일·디렉터리 동기화, 실패 응답, 재시작·복구 동작을 검증한 저장 계약으로 연결한다.
  - ACK 시점을 고정한다. atomic replacement 이후 실패를 미적용으로 단정하지 않는다. 저장본 재검증 전에 이전 cache로 후속 변경을 덮어쓰지 않는다.
- C3 `Test: Verify writer exclusion and recovery across Linux processes`
  - 독립 Linux 프로세스의 동시 기동·강제 종료·잠금 해제·저장 실패를 재현하는 검증을 추가한다.
- **완료 조건:** 두 번째 writer는 변경 전에 거부된다. 저장 실패를 성공으로 응답하지 않는다. 재시작과 백업 복원에서 기존 초안·확정·진행 상태가 일치한다.
- **검증:** 통제된 장애·복원은 격리 자료로 수행한다. 프로세스 종료 검증을 전원 손실 보장으로 표현하지 않는다. 전원 손실과 파일 시스템 내구성은 검증한 범위·한계를 기록한다.

### F04 — 명령 재시도와 처리 기록

- C1 `Feat: Let operators confirm a dispatch command after its response is lost`
  - 요청 식별자, payload 대조, 처리 결과와 작성자·대상·revision·시각을 업무 변경과 일관되게 저장한다.
  - 현재 서버 세션 principal을 receipt 소유자로 기록하고 요청자만 결과를 조회·재전송하게 한다. 별도 기록 저장 실패로 중복 적용이 생기지 않게 한다.
  - 현재 인가와 rate limit 이후 receipt를 대조한다. 확정 receipt는 저장된 처리 결과·commit revision을 반환한다. receipt가 없는 새 요청에만 boot/revision CAS·업무 검증을 적용한다.
  - 업무 변경과 성공 receipt는 하나의 저장 commit으로 처리하고 이후 ACK한다. 현재 snapshot·boot는 별도 조회 계약으로 제공한다.
- C2 `Feat: Keep uncertain dispatch actions attached to their original request`
  - UI가 같은 동작의 식별자를 유지하고 결과 조회·재시도·충돌 안내를 제공한다. 시간 초과를 완료나 실패로 임의 단정하지 않는다.
- **완료 조건:** 동시 재전송·응답 유실·재시작 후 같은 요청은 같은 결과를 반환한다. 다른 payload로 식별자를 재사용하면 거부한다. 다른 사용자 principal이 결과를 읽거나 재사용하지 못한다. 이 단계는 현재 TEST의 단일 자료 공간에 한정된다.
- **설계 조건:** 결과 조회와 재전송에서 권한 검사, rate limit, receipt 대조, boot/revision CAS의 순서를 정한다. 보존·만료 후 처리 정책을 문서화한다. 저장 중 실패와 schema rollback을 함께 검증한다.
- **복구 조건:** receipt를 무시·제거하고 쓰는 구 writer의 기동을 차단한다. 상태만 과거 백업으로 복원해 receipt를 잃는 경로도 검사한다. Git revert만으로 결과 기록이 보존된다고 간주하지 않는다.

### F05 — 테넌트·소속 데이터 경계

- C1 `Feat: Keep business records within their approved tenant scope`
  - 서버 principal과 계정 소속, 원본·자원·배차·처리 기록의 저장 경계를 연결한다. 클라이언트가 보낸 테넌트를 신뢰하지 않는다.
- C2 `Fix: Preserve existing accounts and records during tenant isolation`
  - 기존 계정·자료·F04 처리 기록의 명시적 이행표와 dry-run·복구를 제공한다. 이름이나 날짜로 소속을 추정하지 않는다. 대응 근거가 없는 기존 receipt는 다른 테넌트로 자동 편입하지 않는다.
- **완료 조건:** 테넌트 A가 B의 원본·자원·날짜 상태·명령 결과를 직접 ID로 요청해도 거부된다. 같은 요청 ID의 테넌트 간 조회·재사용·이행을 검사한다. manifest·regions·destinations·원본 파일·게이트웨이가 우회 경로가 되지 않는다.
- **착수 조건:** 테넌트 의미, 자료 소유 시스템과 기존 계정 처리 규칙이 확정돼야 한다. 권한과 이행표가 없는 상태에서 외부 사용자나 실제 명부를 받지 않는다.
- **검증 경계:** 소속·grant가 없는 계정은 전체 자료로 fallback하지 않는다. 직접 Kotlin 요청과 gateway 요청에서 GET·HEAD·gzip·304 처리 전에 인가한다. 가입 직후 소속이 없는 계정도 같은 기준을 적용한다.

### F06 — 역할별 업무 권한

- C1 `Feat: Limit business actions to approved account permissions`
  - 승인된 권한표로 읽기·계산·확정·수정·자원 관리를 서버에서 판정한다. 계정 비활성화·소속 변경·권한 회수를 검사한다.
- C2 `Feat: Show only business actions the current account can perform`
  - 세 화면의 조회·변경 가능 상태와 접근 거부 안내를 연결한다. 숨긴 버튼만으로 권한을 구현하지 않는다.
- **완료 조건:** 허용·거부·권한 회수를 HTTP와 브라우저에서 확인한다. 기사·고객의 상세 권한은 해당 기능 계약에서 확장한다. 역할 이름을 먼저 임의 고정하지 않는다.

### F07 — 실제 차량 등록

- C1 `Feat: Keep registered vehicles tied to their supplied identity`
  - 승인된 명부/수동 등록 계약, 별도 차량 ID, 출처와 등록 상태를 저장한다. 기존 합성 등록부를 자동 검증하지 않는다.
- C2 `Feat: Let operators manage the fleet used for dispatch`
  - 자원 화면에서 등록·조회·변경·비활성화와 중복·저장 충돌을 처리한다. 기존 확정 이력이 참조하는 차량을 삭제하지 않는다.
- **완료 조건:** 실제 인수 표본의 차량 ID·번호판·출처가 재조회 후 유지된다. 누락·중복·충돌을 거부한다. 지역 코드 변경이 차량 신원이나 기사 신원을 바꾸지 않는다.
- **착수 조건:** 차량 식별, 번호판 변경·용차·비활성화 규칙과 인수 방식이 확정돼야 한다. 기사 계정·근무 소속은 별도 계약이다.

### F08 — 등록 차량과 주문 그룹 연결

- C1 `Feat: Calculate dispatch from explicitly linked registered vehicles`
  - 원본 그룹과 차량의 명시적 매핑을 저장하고 계산 후보에 연결한다. 이름·지역 코드로 매핑하지 않는다.
  - `sourceGroupId`와 `vehicleId`를 분리하고 source version·적용 날짜·자원 version을 참조한다.
- C2 `Fix: Keep confirmed dispatch stable when fleet resources change`
  - 초안의 자원 버전을 고정하고 확정 시 재검사한다. 확정된 차량 snapshot은 이후 등록부 변경으로 다시 만들지 않는다.
  - 확정 checkpoint에 당시 차량·매핑 snapshot을 저장한다. 기존 합성 checkpoint와 `legacy_vehicle_catalog`는 별도 출처로 조회하고 자동 변환하지 않는다.
- C3 `Feat: Let operators resolve missing fleet links before dispatch`
  - 미매핑·비활성 차량·버전 충돌을 화면에서 확인하고 수정한다. 계산→확정→관제까지 연결한다.
- **완료 조건:** 허용된 실제 차량만 후보다. 매핑 누락·중복 레코드·허용되지 않은 연결·자원 변경을 거부한다. 승인된 합배는 중복 레코드와 구분한다. 재시작 후 확정 차량·주문·순서가 일치한다.
- **착수 조건:** 같은 날의 합배·분할·용차와 매핑 유효 기간을 정한다. 공식 stable ID가 없으면 날짜·수신 후보 범위를 넘어 매핑을 재사용하지 않는다.

### F09 — 주문 인수 후보 검증과 미리보기

- C1 `Feat: Validate supplied orders before they enter dispatch`
  - 확정된 파일 또는 API 계약 하나를 구현한다. 식별자·버전·단위·시간대·전체/증분·인수 완료 조건과 원본 출처를 검사한다.
- C2 `Feat: Let operators review an order intake before applying it`
  - 후보의 정상·오류·추가·수정·취소·미매핑 내역과 대사 수량을 표시한다. 실패나 부분 수신을 주문 0으로 표시하지 않는다.
  - 불변 후보 ID·내용 버전과 검토 당시 활성 원본·배차 revision을 보존한다. F08이 준비되지 않았으면 차량 연결은 미확인으로 표시한다.
- **완료 조건:** 검증 실패·부분 수신은 현재 원본과 배차를 바꾸지 않는다. 후보는 격리돼 있고 수량·참조·버전을 대조할 수 있다.
- **착수 조건:** 공식 명세와 비식별 계약 표본이 필요하다. 공급자 endpoint·인증·필드명은 자료를 받은 뒤 결정한다.

### F10 — 최초 주문 인수 적용

- C1 `Feat: Apply reviewed order versions without losing dispatch history`
  - 기존 배차가 없는 범위에서 승인 후보를 원자적으로 적용한다. 원본·자원·checkpoint의 교체 책임을 분리한다. 기존 초안·확정·진행·완료 상태는 변경하지 않는다.
- C2 `Feat: Keep order intake approval tied to the reviewed candidate`
  - 후보 ID·내용 버전·활성 원본·배차 revision을 CAS로 대조한다. 검토 후 바뀌면 거부하고 재검토한다. 적용 결과·대사를 보여 준다.
- **완료 조건:** 적용 중 실패·종료·중복 재시도에서 원본·배차·처리 기록이 같은 적용 결과로 복구된다. 마지막 정상 자료를 유지한다. 주문→차량 연결→계산→확정→관제→복구 흐름이 실제 계약 표본으로 통과한다.

### F11 — 기존 주문 변경·취소와 배차 대사

- C1 `Feat: Reconcile order changes with the approved dispatch state policy`
  - 공급 버전·변경·취소·재배차가 각 배차 상태에 미치는 승인된 정책을 구현한다. 중복·역순·누락과 재동기화를 처리한다.
- C2 `Feat: Let operators review the dispatch impact of changed orders`
  - 변경 영향·충돌·적용 결과·대사를 표시한다. 검토 후보와 현재 원본·배차를 F10과 같은 기준으로 대조한다.
- **완료 조건:** 초안·확정·진행·완료별 허용·거부·복구를 확인한다. 진행·완료 기록을 조용히 초기화하지 않는다. 원본·업무 상태·처리 기록의 원자적 범위와 중단 후 복구를 검증한다.
- **착수 조건:** 공식 변경·취소 계약을 받은 뒤 커밋 범위와 복구 단위를 고정한다. 정책의 차이가 크면 배차 상태별로 추가 PR을 나눈다.

## 이후 기능의 독립 PR 경계

다음 항목은 첫 운영자 흐름과 분리한다. 해당 입력이 확보되면 별도 세부 계획에 커밋·계약·완료 조건을 고정한 뒤 구현한다. 아직 endpoint·채널·단말 UI는 정하지 않는다.

| 기능 PR | 필요한 입력 | 커밋 경계와 완료 증거 |
| --- | --- | --- |
| 기사 배차 조회·수신·수락 | 실제 기사 신원·차량·근무, 대상 제품/기기, 재배차 정책 | `Feat:` 기사 권한·배차 전달 기록 / `Feat:` 제품 화면·확인 동작. 서버 확정·기기 전달·수신·수락을 별도로 입증 |
| 배송 증빙 저장 | 필수 증빙, 보존·열람·삭제, 저장 방식 | `Feat:` 업로드·증빙 저장 / `Feat:` 기사 제출·권한 조회. 소유권·중복·실패·재시작 확인 |
| 도착·완료·오프라인 복구 | 상태 전이·필수 증빙·고객 요청 확인, 이벤트 순서 | `Feat:` 내구 이벤트 처리 / `Feat:` 단말 재전송·관제 반영. 오래된 배차 거부와 중복 1회 처리; 증빙 성공 전 완료 금지 |
| 실제 차량 위치 수신 | 위치 공급 방식·기기 신원·시각·정확도·주기 | `Feat:` 위치 검증·저장 / `Feat:` stale·unknown 관제 표시. 역순·중복·단절과 실기기 수신 확인 |
| 실측 기반 ETA | 실제 위치·도로 경로 공급, 평가 표본·목표 | `Feat:` 승인된 ETA 입력·계산 / `Feat:` 계획값·실측값 구분. 현장 오차·지연 측정 |
| 고객 주문 조회 권한 | 고객 신원·매장·주문 소속과 접속 방식 | `Feat:` 고객 범위 조회 / `Feat:` 제품 화면. 다른 고객 주문과 직접 ID 변경 거부 |
| 고객 알림 전달 | 채널·공급자·수신자·동의/거부·재시도 정책 | `Feat:` 영속 발송·공급자 결과 / `Feat:` 운영 상태·고객 이동. 접수·실제 수신·탭을 구분 |
| 지원배차 요청·수락·재배정 | 요청·취소·수락 책임과 충돌·SLA | `Feat:` 승인된 상태 전이 / `Feat:` 요청자·수락자 흐름. 중복 수락과 진행 배차 충돌 거부 |
| QA 환경과 동일 산출물 승격 | 대상 서버·격리 설정·확인 담당 | `CI:` 환경 구성 / `Test:` 격리·승격·복구. 현재 TEST와 계정·자료·비밀값·수신 대상 분리 |
| 운영 환경과 제한적 전환 | QA 결과·운영 대상·복원 기준 | `CI:` 운영 승격 / `Docs:` 실제 복구·운영 절차. 동일 artifact·runtime·업무·현장 증거 확인 |

기능을 제공하지 않는 범위에 기사·고객·GPS 완료를 요구하지 않는다. 실제 제공 범위를 확대할 때 [운영 준비도](production-readiness.md)의 해당 게이트를 충족한다.

## 파일 책임과 구현 방식

- API는 기존 패키지를 우선 확장하고 필요한 입력 검증·정책·HTTP·저장 책임만 분리한다. `DispatchPlan.kt`나 controller 하나에 모든 신원·인수·권한 코드를 모으지 않는다.
- 프런트는 해당 기능의 client·순수 모델·DOM과 공통 컴포넌트를 분리한다. 새 변경 경계는 TypeScript를 사용하고 기존 MJS 경계는 계약과 검사를 유지한다.
- `combined/app.mjs`는 연결·라우팅만 맡는다. 기능별 책임은 [파일 안내](project-structure.md)를 따른다.
- 실제 주문·명부·계정·비밀값은 Git에 넣지 않는다. 계약 회귀는 명시적 비식별 표본을 사용한다.
- UI 변경은 공통 토큰·44px 일반 조작·8px 카드·빈 상태·상단 알림·좁은 화면·키보드 조건을 유지한다. 제품의 신규 업무 흐름에는 서버 구현 용어를 노출하지 않는다.

## 기능 PR 진행 절차

1. 최신 `main`, 현재 TEST 릴리스, dirty state와 기존 PR을 확인한다. 해당 F번호·사용자 동작·선행 조건·상태 소유자를 PR 본문에 적는다.
2. 외부 계약이 필요한 기능은 입력과 정책을 먼저 확정한다. 코드로 추정하지 않는다. 독립적인 착수 가능 기능은 진행한다.
3. 기능별 브랜치를 `fix/fleet-source-truth`, `feat/dispatch-command-receipts`처럼 목적에 맞게 만든다. F번호와 실제 branch·commit·PR은 아래 기록표에 연결한다.
4. 요구 동작과 실패·거부·충돌을 재현하고 목적별 커밋을 만든다. `Codex` 접두사를 쓰지 않으며 Lore의 판단 근거·검증·미검증 trailer를 유지한다.
5. 기능별 검사 후 완성 후보를 한 번 push한다. PR에서 Kotlin·frontend·실제 JAR·관련 provenance/계약을 검사하고 독립 검토를 받는다. 불필요한 테스트 파일을 중복 실행하지 않는다.
6. 독립 검토·PR CI를 통과하면 병합한다. merge commit도 목적 접두사와 Lore 본문을 명시한다. 코드·데이터 이행·복구가 독립적으로 검토될 만큼 커지면 기능을 다시 나눈다.
7. 기본 브랜치 검사와 기존 TEST 자동 배포를 따른다. PR/main은 각 후보의 별도 검사이며 기능 브랜치 push·수동 실행을 더해 중복하지 않는다. 검증한 artifact를 재빌드하지 않는다.
8. runtime SHA·manifest·health, 자료 보존, 인증된 실제 화면과 해당 실패 경로를 확인한다. 계정·키 등 임시 검토 자료를 정리한다.
9. 기능의 PR·commit·CI·배포·화면 증거와 미확인을 [릴리스 기록](templates/release-record.md)에 남긴다. 다음 PR은 병합된 최신 `main`에서 시작한다.

저장 스키마가 바뀌는 PR은 구버전 읽기·쓰기 가능 여부와 rollback 또는 forward recovery를 선언한다. 전환 후 새 기록도 보존한다. 안전하게 함께 이행해야 하는 서버·client·이행 코드와 회귀는 같은 커밋에 둔다. 개별 커밋 복구가 안전하지 않으면 PR 전체를 복구 단위로 명시한다.

계획 문서 PR은 문서 사실·구조·링크를 검증하는 단위다. 이 문서를 작성하는 요청에 업무 기능 구현이나 서버 구성을 포함하지 않는다. 상세 전달 기준은 [커밋·CI·배포 기준](delivery-workflow.md)을 따른다.

## 착수 전 받아야 할 입력

| 입력 | 현재 상태 | 적용 단위 |
| --- | --- | --- |
| 실제 차량·기사 명부 | 사용자 확인: 미확보 | F07·F08·기사 기능 |
| 공식 주문 연동 명세·계약 표본 | 사용자 확인: 미확보 | F09·F10·F11 |
| 테넌트 의미·계정 소속·자료 소유·이행표 | 미확정 | F05 |
| 역할별 업무 권한표·회수 정책 | 미확정 | F06 |
| 차량/기사 식별·용차·합배·분할·매핑 유효 기간 | 미확정 | F07·F08 |
| 명령 결과 보존·만료·조회 범위, 저장·복원 기준 | 설계에서 결정 | F03·F04 |
| 실제 기사·고객 제품과 알림 공급 계약 | 미확정 | 이후 기능 |

## 전달 기록

| 단위 | GitHub PR | 커밋 | 상태·증거 |
| --- | --- | --- | --- |
| 계획 문서 | 이 문서의 PR 본문 | PR 커밋 목록 | 문서 작성·독립 검토 |
| F01–F11 | 미생성 | 미생성 | 구현 미착수 |

다음 구현 착수 단위는 **F01**이다. F02–F04를 이어서 진행할 수 있다. 명부·권한·공급 계약이 준비되면 F05–F11의 선행 조건을 확인하고 실제 업무 흐름을 완성한다.
