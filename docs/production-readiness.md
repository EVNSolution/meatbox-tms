# 운영 준비도

기존 운영 프런트는 `apps/web/` 하나로 포크했고, 인증·원본 조회·날짜별 배차·자원 저장은 Kotlin/Spring API로 이관했다. 실제 기사·고객에게 운영을 확대하려면 **사용자별 데이터 권한, 내구성 있는 업무 기록, 실제 입출력 연동, 작성자 구성의 안전성**을 추가로 입증해야 한다.

이 문서는 현재 코드의 존재와 운영 증거를 분리한다. 과거 배포 기록, 다른 브랜치, 로컬 미커밋 작업은 검토 대상의 운영 준비도에 합산하지 않는다.

현재 구조는 [확정 아키텍처](new-stack-architecture.md)와 [기능별 파일 책임](project-structure.md)을 따른다. TEST native 모드는 보호 웹 게이트웨이와 Kotlin API를 사용하며 기존 Node 업무 API는 중지한다. 기사·고객·시나리오 데모는 [실제 삭제 결과](demo-removal-result.md)의 폐기 범위다. 해당 데모의 동작을 현재 제품 기능으로 합산하지 않는다. QA·운영 환경과 실제 공급자 연결은 후속 범위다.

## 판정 기준

| 표기 | 의미 |
| --- | --- |
| 구현 | 저장소에서 코드와 관련 회귀를 확인할 수 있음 |
| 로컬 검증 | 고정된 환경에서 검증 대상의 명령 성공 기록이 있음 |
| 운영 runtime | 현재 운영 프로세스가 같은 SHA와 설정으로 동작함을 확인함 |
| 실기기·현장 | 실제 계정·기기·네트워크·업무 자료로 끝까지 관찰함 |

한 열의 증거로 다음 열을 추정하지 않는다. 예를 들어 회귀 테스트가 있어도 현재 운영 서버의 SHA를 증명하지 않으며, 운영 화면이 열려도 실제 기사 기기의 GPS나 알림 도달을 증명하지 않는다.

## 구현 경계와 확인할 근거

| 영역 | 구현 경계 | 관련 회귀 | 운영 확대 시 필요한 근거 |
| --- | --- | --- | --- |
| 인증 | Kotlin 초대·가입·로그인·로그아웃, 계정 JSON v1·메모리 세션 | [Kotlin 인증](../services/api/src/test/kotlin/com/evnsolution/meatbox/auth/AuthHttpTest.kt), [native 게이트웨이](../test/api-connection/kotlin-native-gateway.test.mjs) | 테넌트·역할·고객·차량별 접근 제한과 거부 경로 |
| 날짜별 배차 | Kotlin 계산·핀배차·확정·수정안 시작/취소·순서 저장 | [배차](../services/api/src/test/kotlin/com/evnsolution/meatbox/dispatch/DispatchPlanTest.kt), [실제 JAR 명령](../test/api-connection/kotlin-state-owner.test.mjs) | 기존 확정 상태 보존, 충돌·실패·복구와 실제 기사 수신 |
| 체크포인트 | Kotlin 날짜별 JSON v2 저장·기존 운행 기록 복원 | [상태 소유권·재시작](../test/api-connection/kotlin-state-owner.test.mjs) | 선택한 작성자 구성, 비정상 종료, 백업·복원 |
| 자원 등록부 | Kotlin SQLite v2와 revision CAS | [Kotlin 자원](../services/api/src/test/kotlin/com/evnsolution/meatbox/resources/ResourceStoreTest.kt), [실제 JAR 자원](../test/api-connection/kotlin-resources.test.mjs) | 원본 인수·스키마 이행·복구와 저장 후 조회 |
| 배송 사진 | 제품 업로드·증빙 저장 API 미구현; 과거 기사 데모 삭제 | [현재 업무 API](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/DispatchController.kt) | 서버 증빙 저장과 권한·보존·삭제 |
| GPS·ETA | 원본 좌표와 저장된 운행·계획 정보 조회; 실제 기기 수신 미구현 | [관제](../apps/web/combined/vehicle-control.test.mjs), [운행 기록](../services/api/src/test/kotlin/com/evnsolution/meatbox/dispatch/OperationalStateTest.kt) | 실제 기기 입력과 현장 오차·지연 |
| 고객 알림 | 기존 알림 기록 조회; 배차 명령과 외부 전달 결과 연결 미구현 | [운행 기록](../services/api/src/test/kotlin/com/evnsolution/meatbox/dispatch/OperationalStateTest.kt) | 공급자 접수, 실제 수신·클릭·재동기화 |
| 배포 | PR·main CI, 검증한 불변 산출물의 TEST 배포·복구 | [검사 workflow](../.github/workflows/new-stack.yml), [TEST 배포 workflow](../.github/workflows/deploy-test.yml), [배포·복구 도구](../deploy/new-stack/README.md) | 각 후보의 실행 버전·설정 일치와 QA·운영 승격 |

이 표는 기능이 바뀔 때 갱신하는 구현 경계다. 각 배포의 통과·실패·미확인은 [릴리스 기록](templates/release-record.md)에 남긴다.

## 적용 범위와 우선순위

아래 P0/P1은 운영 확대 시 검토할 기술적 전환 기준이다. 실제 외부 사용자를 받거나 해당 기능을 운영에 사용하는 범위에 적용한다. CSV 파일 인수 방식이나 단일 작성 프로세스를 의도적으로 운영하는 경우에는 그 제약과 복구 기준을 입증할 수 있다. 새 DB·메시지 브로커·다중 인스턴스 도입 자체를 완료 조건으로 삼지 않는다.

## P0: 실제 사용자 접근 전에 완료

### 1. principal-resource authorization

Kotlin 세션 principal은 사용자명과 표시 이름을 제공한다. 업무 HTTP 필터는 로그인 여부를 검사하지만 테넌트·운영자·기사·고객 역할이나 주문·차량·매장 소속을 판정하지 않는다. 날짜 상태와 명령은 사용자별 자료 범위로 제한하지 않는다. 화면의 선택 ID와 링크 파라미터는 권한 경계가 아니다. 폐기한 시뮬레이션 WebSocket은 게이트웨이에서 410으로 닫는다.

근거:

- 세션의 공개 사용자 정보와 메모리 세션: [`AuthService.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/auth/AuthService.kt)
- 로그인 여부를 검사하는 업무 필터: [`DispatchSessionFilter.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/DispatchSessionFilter.kt), [`ResourceSessionFilter.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/resources/ResourceSessionFilter.kt)
- 날짜 명령에서 사용자명은 rate limit 키로 사용: [`DispatchController.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/DispatchController.kt)
- 보호 정적 파일·Kotlin 프록시·폐기 경로 차단: [`legacy-gateway.mjs`](../apps/web/scripts/legacy-gateway.mjs)

완료 조건:

- 운영자, 배차 담당자, 기사, 고객 principal과 각 resource 관계를 서버 데이터로 정의한다.
- 주문·배송지·차량·배차 초안·완료 증빙·알림별 읽기/쓰기 권한을 deny-by-default로 검사한다.
- 기사 A가 기사 B 차량을 조회·변경하고 고객 A가 고객 B 주문을 조회하는 요청을 HTTP와 직접 ID 변경에서 거절한다. 실시간 조회 경로를 추가하면 같은 권한 검사를 적용한다.
- 명령 감사 기록에 principal, resource, 요청 ID, 이전/이후 revision, 결과 시각을 남긴다.
- 기존 검토 계정의 이행 규칙과 권한 회수 절차를 문서화하고 권한 거부 회귀를 배포 게이트로 둔다.

### 2. 업무 상태·증빙의 영속성과 복구

Kotlin 날짜별 배차 상태는 JSON 체크포인트 v2에 저장한다. 임시 파일을 동기화한 뒤 atomic rename으로 교체한다. 디렉터리 fsync는 구현하지 않아 전원 손실 시 최신 교체의 내구성은 별도 검증이 필요하다. 기존 확정 운행·진행·완료 기록은 복원하지만 실제 기사 명령과 사진 업로드 API는 아직 없다. 로그인 세션은 프로세스 메모리에 보관한다.

근거:

- 체크포인트 쓰기와 저장 실패 처리: [`DispatchStore.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/DispatchStore.kt)
- 기존 운행 기록 복원: [`OperationalState.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/OperationalState.kt)
- 메모리 세션: [`AuthService.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/auth/AuthService.kt)
- 현재 제품의 여섯 업무 명령: [`DispatchController.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/DispatchController.kt)

완료 조건:

- 주문, 배차 revision, 수락, 도착, 완료, 고객 요청 확인, 알림을 하나의 내구성 있는 업무 원장에 기록한다.
- 사진은 서버가 발급한 업로드/증빙 ID, 체크섬, 촬영·업로드 principal, 배송 resource, 보존·삭제 상태와 연결한다.
- 증빙 저장과 필수 요청 확인이 성공한 뒤에만 완료 상태를 원자적으로 확정한다.
- 정상 재시작, 강제 종료, 저장 중 실패, 백업 복원, 이전 버전 롤백에서 상태와 증빙 관계를 검증한다.
- 개인정보 접근, 보존 기간, 삭제, 감사 조회 정책을 운영 절차로 확정한다.

### 3. multi-writer 내구성과 idempotency

Kotlin 날짜별 상태 조회·명령은 서비스 내부 `@Synchronized`로 직렬화하며 boot/revision 충돌을 검사한다. 체크포인트에는 여러 업무 프로세스를 조정하는 lock 또는 fencing token이 없다. 계정 JSON은 프로세스 lock과 디렉터리 lock을 쓰지만 stale lock 자동 복구와 분산 저장소는 제공하지 않는다. 자원 SQLite는 `BEGIN IMMEDIATE`, revision CAS와 `busy_timeout`을 사용한다. 최종 다중 작성자 계약과 외부 명령의 영속 idempotency 기록은 아직 없다.

native 배포 도구는 기존 Node writer를 중지하고 Kotlin writer를 선택한다. 배포·복구의 호스트 lock과 예상 활성 릴리스 검사는 전환을 보호하며 업무 프로세스의 동시 작성 lock을 대신하지 않는다.

근거:

- 날짜별 프로세스 내부 동기화: [`DispatchStore.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/DispatchStore.kt)
- 접근 파일 lock: [`AtomicAccessFile.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/auth/AtomicAccessFile.kt)
- 자원 SQLite transaction·대기 제한: [`ResourceStore.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/resources/ResourceStore.kt)
- writer 전환·복구 lock: [`배포 도구 설명`](../deploy/new-stack/README.md)

완료 조건:

- 단일 active writer를 강제하거나, 여러 instance가 공유하는 transactional 저장소와 fencing을 채택한다.
- 모든 외부 명령에 안정된 idempotency key와 처리 결과를 보존한다.
- 단일 writer 구성이면 두 번째 작성 프로세스의 기동·동시 활성화를 막는 운영 통제를 검증한다. 다중 instance 구성이라면 같은 revision 변경·failover도 검증한다. 두 구성 모두 응답 유실 후 재시도, 장시간 lock, 저장소 일시 장애를 검증한다.
- 충돌·재시도·실패 지표와 경보를 정의하고, 저장 실패 시 성공 응답을 보내지 않는다.

### 4. 외부 주문·기사·배차 공급 계약

현재 날짜 데이터는 준비된 manifest와 JSON 파일에서 읽는다. 저장소에는 외부 Meatbox API, webhook, 메시지 브로커의 인증·버전·재전송 계약이 없다. CSV/JSON 준비 경계는 어댑터 개발에 유용하지만 운영 공급자 계약을 대신하지 않는다.

근거:

- 파일 기반 날짜 조회: [`DispatchDataReader.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/compat/DispatchDataReader.kt)
- 날짜 상태 생성: [`DispatchStore.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/DispatchStore.kt), [`DispatchPlan.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/DispatchPlan.kt)
- 준비 스크립트: [`prepare-dispatch-data.py`](../scripts/prepare-dispatch-data.py), [`prepare-destination-data.py`](../scripts/prepare-destination-data.py)

완료 조건:

- 공급자와 파일/API 인수 방식, 인증, stable ID, 버전, 전체/증분 구분, 취소·수정·재배차, 삭제, 시간대, 인수 완료 조건을 확정한다. 파일 인수를 사용하는 범위에 실시간 webhook을 필수로 요구하지 않는다.
- 원본 event ID와 버전을 보존하고 중복·역순·누락·부분 실패를 idempotent하게 처리한다.
- 원본 계약 fixture와 소비자 contract test를 버전 관리하고, 알 수 없는 필드·참조·수량은 조용히 보정하지 않고 격리한다. 현재 서버 로더에는 URL 날짜와 day 본문 날짜의 직접 일치 검사가 없으므로 이 경계도 검증·보강한다.
- 재동기화와 대사 절차가 확정될 때까지 준비된 파일을 운영 실시간 원장으로 표현하지 않는다.

## P1: 현장 운영 신뢰성 확보

### 5. 실제 GPS와 ETA 성능

현재 관제 지도는 원본에 있는 좌표를 표시하며 좌표가 없으면 자료 없음으로 표시한다. 기존 계획·운행 기록 조회를 실제 기기의 GPS·ETA 수신으로 해석하지 않는다. 기사 위치를 서버에 보내는 제품 API, 위치 정확도·시각·장치 신원 검증, map matching과 오래된 위치 거절은 아직 없다.

근거: [`vehicle-control.mjs`](../apps/web/combined/vehicle-control.mjs), [`OperationalState.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/OperationalState.kt), [`현재 업무 API`](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/DispatchController.kt).

완료 조건:

- 기사 기기와 차량·근무 세션을 연결하고 위치 시각, 수신 시각, 정확도, 공급자, sequence를 저장한다.
- 권한 거부, 백그라운드, offline buffer, 역순·중복, 비정상 이동, 오래된 위치를 명시적으로 처리한다.
- 계획 ETA와 실측 기반 ETA를 별도 필드와 화면 문구로 유지하고 입력이 부족하면 unknown/stale을 표시한다.
- 운영 전 평가 규칙을 고정한 뒤 실제 배송 표본에서 예측 시각과 실제 도착 시각을 비교한다. 표본 수, 데이터 제외율, 시간대·권역·노선별 오차 분포와 갱신 지연을 함께 보고한다.
- 로컬 재생 시험과 실제 기사 기기·현장 시험을 별도 증거로 남긴다. 목표 수치가 정해지기 전에는 “정확” 또는 “실시간”이라고 릴리스하지 않는다.

### 6. 기사 수신·오프라인·외부 알림

배차 확정은 서버 snapshot에 반영되지만 기사 기기 수신·수락·거절·재배차 acknowledgment는 제품 API에 없다. 기존 고객 알림 기록 조회도 현재 배차의 외부 전달 결과를 증명하지 않는다. 별도 Push Lab 서비스와 기존 Push 작업은 유지하지만 배차·알림의 제품 통합 완료로 합산하지 않는다.

근거: [`DispatchController.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/DispatchController.kt), [`OperationalState.kt`](../services/api/src/main/kotlin/com/evnsolution/meatbox/dispatch/OperationalState.kt), [`Push 서비스 보존 경계`](../deploy/new-stack/README.md).

완료 조건:

- 배차 확정, 기기 전달, 기사 수신, 수락/거절을 서로 다른 상태와 시각으로 기록한다.
- offline 재연결과 중복 command에서 같은 최종 결과를 보장하고 오래된 배차의 완료를 거절한다.
- 알림 event ID, 공급자 message ID, 재시도, 영구 실패, opt-out을 보존한다.
- Android/iPhone 등 지원 대상별로 실제 표시, 탭, 인증된 주문 이동까지 확인한다.

### 7. 관측·백업·재해 복구·릴리스 증명

저장소에는 PR·main CI와 TEST 자동 배포 workflow가 있다. CI에서 전체 검사를 통과한 불변 산출물을 배포하며 서버에서 manifest·Git SHA·활성 모드·서비스 health를 확인한다. 배포·복구 도구는 업무 자료를 보존하고 전환 전 백업을 확보한다. 중앙 지표·로그·경보와 RPO/RTO는 별도 운영 계약이 필요하다. 과거 실행 문서는 당시 증거이며 현재 후보와 실행 중인 서비스가 같다는 뜻이 아니다.

근거: [`검사 workflow`](../.github/workflows/new-stack.yml), [`TEST 배포 workflow`](../.github/workflows/deploy-test.yml), [`산출물 확인·배포·복구`](../deploy/new-stack/README.md).

완료 조건:

- 깨끗한 격리 환경의 테스트를 commit SHA에 연결하고 실패 시 후보 승격을 차단한다.
- runtime이 불변 버전과 readiness를 노출하고 배포 후 후보 SHA와 일치시킨다.
- 인증 실패, 명령 오류, 저장 지연/실패, 요청 대기, ETA stale, 외부 공급 실패를 관측한다. 실시간 연결을 추가하면 연결 상태도 관측한다.
- 접근 파일, 업무 원장, 자원 DB, 사진 객체의 백업·복원과 RPO/RTO를 정하고 복구 훈련 결과를 남긴다.
- 기존 확정 배차와 진행 상태를 보존한 롤백을 검증한다.

## P2: 운영 정책 확정 후 완성

- 보존 기간, 개인정보 열람·삭제, 계정 퇴사/회수, 감사 조회 정책
- 지원배차 요청·수락·취소·재배정 책임과 SLA
- 배차 알고리즘 평가 데이터, 성공 지표, 수동 override와 설명 가능성
- 실제 좌표·권역 경계·차량/기사 master의 소유 시스템과 변경 승인
- 브라우저 접근성, 지원 OS·브라우저, 저사양 기기 성능 기준

## 운영 승격 게이트

대상 릴리스마다 아래 증거를 확인하고 결과를 [릴리스 기록](templates/release-record.md)에 남긴다. 이 문서에는 특정 배포의 통과 여부를 적지 않는다.

| 게이트 | 승인에 필요한 증거 |
| --- | --- |
| G1 소스 | 후보의 전체 회귀와 변경 범위 검토 |
| G2 보안·인가 | 테넌트·역할·소속별 허용 및 거부 경로의 HTTP 검증; 추가하는 실시간 경로도 같은 기준 적용 |
| G3 데이터 내구성 | 선택한 작성자 구성, 저장 실패·재시작·백업·복원, 감사 기록 |
| G4 외부 계약 | 사용하는 주문·GPS·알림 공급 계약과 계약 테스트 |
| G5 후보·runtime | 불변 산출물과 실제 실행 버전의 일치, 상태 점검, 롤백 |
| G6 실기기·현장 | 지원 계정·기기에서 사용하는 기능의 전체 흐름과 단절 복구 |

사용 범위에 필요한 게이트가 충족되어야 운영을 확대한다. 과거 배포나 별도 브랜치의 결과는 대상 릴리스의 검증을 대신하지 않는다.

현행 로컬 실행은 [새 스택 개발 환경](new-stack-development.md), 검사·배포 흐름은 [변경 전달 기준](delivery-workflow.md), 배포·백업·복구는 [새 스택 배포 도구](../deploy/new-stack/README.md)를 따른다. 기존 [검증 가이드](verification.md)와 [보안·접근 제어](security-and-access.md)는 참고 자료다. 현행 소유권과 폐기한 데모의 경계는 위 구현 근거를 우선한다.
