# 연결 이관과 TEST 배포 작업

2026-10-05, Asia/Seoul. 사용자는 연결 작업 이후 필요한 이관·배포·검증을 계속 수행하도록 승인했다. 현재 미커밋 프런트 포크와 Kotlin 조회 API를 보존한다.

## 요구와 완료 기준

기존 화면과 인증·날짜별 확정 상태를 유지하면서 새 프런트와 Kotlin API를 실제 TEST 배포 경로에 연결한다. 현재 대상은 AWS에서 확인한 `meatbox` 인스턴스이며 기존 검토자 서비스의 상태는 덮어쓰지 않는다. 서버·서비스·활성 릴리스·저장 경로·용량을 먼저 재확인한다.

- 누적 배송지 조회를 Kotlin으로 이관한다. `lib/dispatch-data.js`의 manifest signature/date shift 검증, 누적·검색·정렬·페이지네이션·오류 계약을 Node와 비교한다. 같은 세션 확인과 명시적 reader 오류 경계를 적용한다.
- 자원 등록부는 조회와 네 쓰기 경로를 하나의 Kotlin 소유 단위로 이관한다. 현재 SQLite v2 형식·revision·FK·트랜잭션을 보존한다. Node 자원 경로는 명시적으로 비활성화해 이중 writer를 막는다. 계정/날짜별 배차 writer는 현재 Node가 유지한다.
- 보호 gateway는 정확한 HTTPS 공개 origin과 loopback 수신 주소를 분리한다. 인증된 보호 자산·쿠키·Origin·CSP·WebSocket·장애 거부가 유지돼야 한다. 원시 Vite preview를 인터넷에 공개하지 않는다.
- 변경하지 않은 활성 Node와 새 서비스를 분리 배치해 먼저 검증한다. 원본 source/계정/운행 checkpoint를 재계산하거나 합성 자료로 교체하지 않는다. 실제 자료에 쓰기 이관이 필요하면 백업·복원·단일 writer 전환과 CAS를 검증한 뒤 적용한다.
- 릴리스는 프런트·JAR·Node 연결 코드·설정 template의 SHA256 조합으로 식별한다. TEST에서 health·비인증 거부·인증 조회·자산·재기동/롤백을 검증한다. QA/운영 서버는 새로 생성하지 않는다.

## 구현 순서

1. 서버 read-only preflight, 데이터/배포 계약 확인.
2. 누적 배송지와 자원 이관을 독립 파일 소유로 구현하고 Node parity·실제 JAR·restart 검증.
3. HTTPS gateway·systemd와 재현 가능한 배포/복구 도구, 단일 writer 구성 검증.
4. 전체 lint/type/build/test, 독립 코드·배포 검토.
5. 서버 격리 후보 실행, 자원 복사본 검증, 원본 해시 재확인, TEST 트래픽 전환 및 복구 검증.
6. 인증 브라우저의 조회·자원·배차·기사·관제·고객 화면을 확인하고 결과 기록.

## 범위와 남은 계약

전체 Kotlin 목표를 단계별로 이관한다. 날짜별 state/commands는 동일 엔진·checkpoint·boot/revision을 함께 교체해야 하며 원본 confirmed state 호환성 없이 일부만 이전하지 않는다. 실제 공급자 인증·주문 변경/취소, 역할/tenant/고객 공개 권한, 실제 GPS·사진·알림은 확인한 외부 계약이 없으므로 기존 시연으로 완료 판정하지 않는다. 이 작업은 현재 제공 동작의 연결·이관이며 새 외부 계약을 추정하지 않는다.

기존 `test/dispatch-data.test.js`, `test/resource*.test.js`와 gateway 회귀를 기대 동작 근거로 유지한다. 작성과 독립 검토를 분리하며 새 수정 뒤에는 provenance 현재 해시를 갱신한다. 서버 접근이 실패하면 기존 권한 내 다른 접근 경로를 확인하고 로컬 구현·검증을 계속한다.

## 실행 결과

새 프런트·Kotlin 읽기/자원 소유 단위를 TEST에 전환하고 롤백·동일 릴리스 재적용·서비스 재시작·인증 화면을 검증했다. 실제 수치, 실행 소유자와 남은 이관 경계는 [TEST 배포 결과](test-stack-rollout-result.md)에 기록했다.
