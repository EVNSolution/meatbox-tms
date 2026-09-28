# 운영 준비도

구현에는 날짜별 배차와 상태 보존, 자원 등록부가 구현되어 있다. 실제 기사·고객에게 운영을 확대하려면 아래 접근 통제·증빙·복구·연동 조건을 추가로 입증해야 한다. 가장 큰 차이는 화면 완성도가 아니라 **사용자별 데이터 권한, 내구성 있는 업무 기록, 실제 입출력 연동, 다중 writer 안전성**이다.

이 문서는 현재 코드의 존재와 운영 증거를 분리한다. 과거 배포 기록, 다른 브랜치, 로컬 미커밋 작업은 검토 대상의 운영 준비도에 합산하지 않는다.

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
| 인증 | 초대·가입·로그인·메모리 세션 | [인증](../test/access.test.js), [게이트웨이](../test/gateway.test.js) | 역할·고객·차량별 접근 제한과 거부 경로 |
| 날짜별 배차 | 초안·확정·수정안 | [배차](../test/dispatch-operations.test.mjs), [명령 API](../test/source-operations-api.test.js) | 기존 확정 상태 보존, 충돌·실패·복구 |
| 체크포인트 | `DISPATCH_STATE_DIR` 설정 시 JSON 저장 | [통합](../test/system-integration.test.mjs) | 단일 작성자 통제, 비정상 종료, 백업·복원 |
| 자원 등록부 | 별도 SQLite와 revision CAS | [자원 API](../test/resource-api.test.js) | 원본 인수·스키마 이행·복구와 저장 후 조회 |
| 배송 사진 | 예시 이미지·로컬 미리보기와 완료 전 확인 | [완료 처리](../test/scenario-controls.test.js) | 서버 증빙 저장과 권한·보존·삭제 |
| GPS·ETA | 예시 위치와 계획·시뮬레이션 표시 | [시간 계산](../test/vehicle-timing.test.js) | 실제 기기 입력과 현장 오차·지연 |
| 고객 알림 | 화면 내부 이벤트와 목록 | [배송 흐름](../test/fleet-flow.test.js) | 공급자 접수, 실제 수신·클릭·재동기화 |
| 배포 | systemd·Caddy 템플릿 | [검증 절차](verification.md) | 불변 후보와 실제 실행 버전·설정의 일치 |

이 표는 기능이 바뀔 때 갱신하는 구현 경계다. 각 배포의 통과·실패·미확인은 [릴리스 기록](templates/release-record.md)에 남긴다.

## 적용 범위와 우선순위

아래 P0/P1은 운영 확대 시 검토할 기술적 전환 기준이다. 실제 외부 사용자를 받거나 해당 기능을 운영에 사용하는 범위에 적용한다. CSV 파일 인수 방식이나 단일 작성 프로세스를 의도적으로 운영하는 경우에는 그 제약과 복구 기준을 입증할 수 있다. 새 DB·메시지 브로커·다중 인스턴스 도입 자체를 완료 조건으로 삼지 않는다.

## P0: 실제 사용자 접근 전에 완료

### 1. principal-resource authorization

현재 세션 principal은 사용자명과 표시 이름을 제공한다. 로그인한 사용자는 같은 HTTP·WebSocket 경로를 통해 날짜 전체 상태와 명령에 접근하며, 운영자·기사·고객 역할이나 주문·차량·매장 소속을 서버가 판정하지 않는다. 화면의 선택 ID와 링크 파라미터는 권한 경계가 아니다.

근거:

- 세션의 공개 사용자 정보와 메모리 세션: [`access.js`](../lib/access.js)
- 로그인 여부만 확인한 뒤 API와 WebSocket을 여는 흐름: [`server.js`](../server.js)
- 날짜 상태·명령에서 사용자명은 rate limit 키로만 사용: [`source-operations-router.js`](../lib/source-operations-router.js)

완료 조건:

- 운영자, 배차 담당자, 기사, 고객 principal과 각 resource 관계를 서버 데이터로 정의한다.
- 주문·배송지·차량·배차 초안·완료 증빙·알림별 읽기/쓰기 권한을 deny-by-default로 검사한다.
- 기사 A가 기사 B 차량을 조회·변경하고 고객 A가 고객 B 주문을 조회하는 요청을 HTTP, WebSocket, 직접 ID 변경 모두에서 거절한다.
- 명령 감사 기록에 principal, resource, 요청 ID, 이전/이후 revision, 결과 시각을 남긴다.
- 기존 검토 계정의 이행 규칙과 권한 회수 절차를 문서화하고 권한 거부 회귀를 배포 게이트로 둔다.

### 2. 업무 상태·증빙의 영속성과 복구

현재 날짜별 배차 상태는 `DISPATCH_STATE_DIR`이 있을 때 JSON 체크포인트로 저장된다. 파일 동기화 후 atomic rename을 사용하지만 디렉터리 fsync는 하지 않아 전원 손실 시 최신 rename을 잃을 수 있음을 코드가 명시한다. 시나리오 상태와 로그인 세션은 프로세스 메모리다. 배송 사진은 object URL 또는 포함된 예시 이미지로 미리보기만 하며 서버에 전송되지 않는다.

근거:

- 체크포인트 쓰기와 한계: [`source-operations-router.js`](../lib/source-operations-router.js)
- 메모리 시뮬레이션: [`operating-simulation.js`](../lib/operating-simulation.js)
- 사진 미리보기와 `hasPhoto` 명령: [`driver.mjs`](../apps/combined/driver.mjs)

완료 조건:

- 주문, 배차 revision, 수락, 도착, 완료, 고객 요청 확인, 알림을 하나의 내구성 있는 업무 원장에 기록한다.
- 사진은 서버가 발급한 업로드/증빙 ID, 체크섬, 촬영·업로드 principal, 배송 resource, 보존·삭제 상태와 연결한다.
- 증빙 저장과 필수 요청 확인이 성공한 뒤에만 완료 상태를 원자적으로 확정한다.
- 정상 재시작, 강제 종료, 저장 중 실패, 백업 복원, 이전 버전 롤백에서 상태와 증빙 관계를 검증한다.
- 개인정보 접근, 보존 기간, 삭제, 감사 조회 정책을 운영 절차로 확정한다.

### 3. multi-writer 내구성과 idempotency

날짜별 명령 queue와 revision 검사는 한 Node 프로세스 안에서만 직렬화한다. 파일 체크포인트에는 여러 프로세스를 조정하는 lock 또는 fencing token이 없다. 접근 계정 파일은 디렉터리 lock을 쓰지만 stale lock 복구와 분산 저장소를 제공하지 않는다. 자원 SQLite는 `BEGIN IMMEDIATE`와 revision CAS를 사용하지만 `journal_mode=DELETE`이며 명시적 `busy_timeout`이나 여러 프로세스 부하 계약이 없다.

근거:

- 날짜별 프로세스 내부 queue: [`source-operations-router.js`](../lib/source-operations-router.js)
- 접근 파일 lock: [`access.js`](../lib/access.js)
- 자원 SQLite transaction: [`resource-store.js`](../lib/resource-store.js)

완료 조건:

- 단일 active writer를 강제하거나, 여러 instance가 공유하는 transactional 저장소와 fencing을 채택한다.
- 모든 외부 명령에 안정된 idempotency key와 처리 결과를 보존한다.
- 단일 writer 구성이면 두 번째 작성 프로세스의 기동·동시 활성화를 막는 운영 통제를 검증한다. 다중 instance 구성이라면 같은 revision 변경·failover도 검증한다. 두 구성 모두 응답 유실 후 재시도, 장시간 lock, 저장소 일시 장애를 검증한다.
- 충돌·재시도·실패 지표와 경보를 정의하고, 저장 실패 시 성공 응답을 보내지 않는다.

### 4. 외부 주문·기사·배차 공급 계약

현재 날짜 데이터는 준비된 manifest와 JSON 파일에서 읽는다. 저장소에는 외부 Meatbox API, webhook, 메시지 브로커의 인증·버전·재전송 계약이 없다. CSV/JSON 준비 경계는 어댑터 개발에 유용하지만 운영 공급자 계약을 대신하지 않는다.

근거:

- 파일 기반 날짜 조회: [`dispatch-data.js`](../lib/dispatch-data.js)
- 날짜 상태 생성: [`source-operations-router.js`](../lib/source-operations-router.js)
- 준비 스크립트: [`prepare-dispatch-data.py`](../scripts/prepare-dispatch-data.py), [`prepare-destination-data.py`](../scripts/prepare-destination-data.py)

완료 조건:

- 공급자와 파일/API 인수 방식, 인증, stable ID, 버전, 전체/증분 구분, 취소·수정·재배차, 삭제, 시간대, 인수 완료 조건을 확정한다. 파일 인수를 사용하는 범위에 실시간 webhook을 필수로 요구하지 않는다.
- 원본 event ID와 버전을 보존하고 중복·역순·누락·부분 실패를 idempotent하게 처리한다.
- 원본 계약 fixture와 소비자 contract test를 버전 관리하고, 알 수 없는 필드·참조·수량은 조용히 보정하지 않고 격리한다. 현재 서버 로더에는 URL 날짜와 day 본문 날짜의 직접 일치 검사가 없으므로 이 경계도 검증·보강한다.
- 재동기화와 대사 절차가 확정될 때까지 준비된 파일을 운영 실시간 원장으로 표현하지 않는다.

## P1: 현장 운영 신뢰성 확보

### 5. 실제 GPS와 ETA 성능

현재 source 상태의 차량 위치는 예시 출처이고 ETA는 기존 계획·시뮬레이션 입력에서 계산된다. 브라우저가 실제 기사 기기의 위치를 서버로 보내는 경로, 위치 정확도·시각·장치 신원 검증, map matching, 오래된 위치 거절은 없다.

완료 조건:

- 기사 기기와 차량·근무 세션을 연결하고 위치 시각, 수신 시각, 정확도, 공급자, sequence를 저장한다.
- 권한 거부, 백그라운드, offline buffer, 역순·중복, 비정상 이동, 오래된 위치를 명시적으로 처리한다.
- 계획 ETA와 실측 기반 ETA를 별도 필드와 화면 문구로 유지하고 입력이 부족하면 unknown/stale을 표시한다.
- 운영 전 평가 규칙을 고정한 뒤 실제 배송 표본에서 예측 시각과 실제 도착 시각을 비교한다. 표본 수, 데이터 제외율, 시간대·권역·노선별 오차 분포와 갱신 지연을 함께 보고한다.
- 로컬 재생 시험과 실제 기사 기기·현장 시험을 별도 증거로 남긴다. 목표 수치가 정해지기 전에는 “정확” 또는 “실시간”이라고 릴리스하지 않는다.

### 6. 기사 수신·오프라인·외부 알림

배차 확정은 서버 snapshot에 반영되지만 기사 기기 수신·수락·거절·재배차 acknowledgment가 없다. 고객 알림도 화면 내부 기록이며 FCM, Web Push, 문자 공급자의 운영 결과가 아니다.

완료 조건:

- 배차 확정, 기기 전달, 기사 수신, 수락/거절을 서로 다른 상태와 시각으로 기록한다.
- offline 재연결과 중복 command에서 같은 최종 결과를 보장하고 오래된 배차의 완료를 거절한다.
- 알림 event ID, 공급자 message ID, 재시도, 영구 실패, opt-out을 보존한다.
- Android/iPhone 등 지원 대상별로 실제 표시, 탭, 인증된 주문 이동까지 확인한다.

### 7. 관측·백업·재해 복구·릴리스 증명

저장소에는 systemd와 Caddy 예시가 있지만 CI workflow, runtime SHA endpoint, 중앙 지표·로그·경보 계약은 없다. 과거 배포 문서는 당시 증거이며 검토 대상과 실행 중인 서비스가 같다는 뜻이 아니다.

완료 조건:

- 깨끗한 격리 환경의 테스트를 commit SHA에 연결하고 실패 시 후보 승격을 차단한다.
- runtime이 불변 버전과 readiness를 노출하고 배포 후 후보 SHA와 일치시킨다.
- 인증 실패, 명령 오류, 저장 지연/실패, queue, WebSocket 연결, ETA stale, 외부 공급 실패를 관측한다.
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
| G2 보안·인가 | 역할·소속별 허용 및 거부 경로의 HTTP·WebSocket 검증 |
| G3 데이터 내구성 | 선택한 작성자 구성, 저장 실패·재시작·백업·복원, 감사 기록 |
| G4 외부 계약 | 사용하는 주문·GPS·알림 공급 계약과 계약 테스트 |
| G5 후보·runtime | 불변 산출물과 실제 실행 버전의 일치, 상태 점검, 롤백 |
| G6 실기기·현장 | 지원 계정·기기에서 사용하는 기능의 전체 흐름과 단절 복구 |

사용 범위에 필요한 게이트가 충족되어야 운영을 확대한다. 과거 배포나 별도 브랜치의 결과는 대상 릴리스의 검증을 대신하지 않는다.

로컬 실행은 [개발 환경](development.md), 검증 결과 작성은 [검증 가이드](verification.md), 배포·백업 절차는 [운영 가이드](operations.md), 인증 경계는 [보안과 접근 제어](security-and-access.md)를 따른다.
