# TEST 로그인·배차 저장 Kotlin 이관 결과

2026-10-05, Asia/Seoul. [이관 계획](kotlin-state-migration-plan.md)에 따라 TEST 한 대의 로그인·계정·세션과 날짜별 운영 배차 명령을 Kotlin으로 전환했다. 기존 확정 155대·초안 149대와 계정·초대·자원 자료를 보존했다. 이전 연결 단계의 [배포 기록](test-stack-rollout-result.md)은 당시 결과로 유지한다.

이 문서는 `c1f29a657678-e6d5ebd59edd91ee` 이관 당시 기록이다. 후속 작업에서 데모 194개 파일을 실제 삭제하고 `c1f29a657678-7cc16465b91dc217`로 TEST를 재전환했다. 최종 활성 버전·검사 수·복구 경로는 [실제 삭제 결과](demo-removal-result.md)와 [중간 정리](migration-checkpoint-2026-10-05.md)를 따른다.

## 이관 당시 실행 구조

```text
HTTPS Caddy
  ├─ /push-lab/* → 기존 Push 서비스 :3300
  └─ 프런트 게이트웨이 :4173 → apps/web 정적 빌드
                               └─ 업무·인증 API → Kotlin :8081
```

`meatbox-api`와 `meatbox-web`은 active/enabled다. 기존 업무 Node 서버 `meatbox-gateway`는 inactive/disabled, PID 0이며 3001 포트의 listener가 없다. 프런트 게이트웨이는 정적 파일·보호 접근·프록시를 담당하며 계정·배차·자원 쓰기를 소유하지 않는다. 기존 Node 코드와 릴리스는 복구 근거로 보존한다.

| 계약 | 현재 소유자 |
| --- | --- |
| 로그인·등록·로그아웃·세션·계정/초대 저장 | Kotlin `auth/` |
| 원본 manifest·일별 주문·권역·누적 배송지 조회 | Kotlin `compat/` 파일 입력 어댑터 |
| 날짜별 상태·배차 계산·핀배차·확정·수정안 시작/취소·순서 저장 | Kotlin `dispatch/` |
| 기존 확정 운행·진행·완료 기록 복원과 조회 | Kotlin `dispatch/OperationalState.kt` |
| 지역 코드·차량 자원 조회/변경 | Kotlin `resources/` |
| 과거 고객·기사·시나리오 데모 및 시뮬레이션 WebSocket | 새 native 실행에서 410; 삭제 대상 |
| Push 관리 화면의 TMS 세션 확인 | 기존 Push 서비스가 Kotlin `/api/session`을 확인 |

Push의 기존 사용자 allowlist를 유지했다. 익명 요청은 401, 유효하지만 allowlist에 없는 검토 계정은 403이다. Push worker는 전환·복구·재전환·재시작 중 PID 167808/NRestarts 0을 유지했고 메시지 전송을 검증용으로 실행하지 않았다.

## 릴리스와 복구

| 항목 | 값 |
| --- | --- |
| Git 기준 SHA | `c1f29a657678b51af888d6be2574103d89c1562f` |
| 이전 연결 릴리스 | `c1f29a657678-11d6601e86df91df` |
| 적용 릴리스 | `c1f29a657678-e6d5ebd59edd91ee` |
| 실행 JAR SHA-256 | `9fed18fdad5d1f451503dd6aa457e8836989dc79a2c48c55fe8453bfe93d3b0c` |
| 전송 archive SHA-256 | `8b6137e43217a93896130b1f66d6b10767ff1c17c5e20b5098dbed11e103cecb` |
| 첫 전환 백업 | `/var/backups/meatbox-tms/20261005T113537Z-226942` |
| 재전환 백업 | `/var/backups/meatbox-tms/20261005T113807Z-227882` |
| TEST 인스턴스 | `i-03d1f27429c948b7d`, ap-northeast-2 |
| 공개 주소 | `https://3.36.96.156/combined/` |

패키지는 실제 JAR·프런트 빌드·실행/복구 도구의 해시와 파일 allowlist를 검증한다. Git SHA만으로 로컬 변경을 식별하지 않으며 내용 해시가 포함된 릴리스 ID를 사용한다. 계정·주문·checkpoint·DB·비밀값은 패키지에 포함하지 않는다.

첫 native 전환 뒤 같은 도구로 이전 연결 릴리스로 복구하고, 같은 검증된 패키지를 다시 native로 적용했다. 복구는 코드·설정·서비스 활성 상태를 되돌리며 최신 업무 자료를 과거 백업으로 덮어쓰지 않는다. Push 환경 파일도 백업·복구하며 세션 URL 한 항목만 3001↔8081로 바꾼다.

계정·배차·자원의 writer를 모두 중지한 뒤 접근 제한된 업무 백업과 해시를 확보했다. 원본 데이터셋은 readonly 입력이고 현재 자료 경로는 `/var/lib/meatbox-demo/`다. 백업은 root 전용이며 자료 디렉터리/파일은 0700/0600이다. 현재 저장소의 수동 복구 도구는 배포 시 확보한 백업 경로와 예상 활성 `mode:releaseId`를 지정한다. 아래는 당시 native 활성 상태를 기준으로 한 예시다. 이번 Git 기준점에서는 새 복구 도구를 TEST에 배포하지 않았으며, 기존 고정 릴리스의 이전 ID 입력 계약과 섞어 실행하지 않는다. 실행 직전 활성 모드·ID를 다시 확인한다.

```sh
sudo sh /path/to/reviewed-source/deploy/new-stack/rollback.sh \
  /var/backups/meatbox-tms/20261005T113807Z-227882 \
  native:c1f29a657678-e6d5ebd59edd91ee
```

이 명령은 현재 native를 이전 연결 릴리스로 되돌린다. 복구 후 health·로그인·자료 조회를 확인하고 전환/서비스 재시작으로 초기화된 세션은 다시 로그인한다.

## 실제 자료 보존과 메모리

각 전환 단계에서 응답의 boot 식별자만 제외한 전체 날짜 상태를 전환 전 Node 응답과 대조했다. 계정/초대의 모든 기존 항목도 일치했다. 운영 자료를 검증용으로 계산·확정·수정하지 않았다.

| 자료 | 유지한 상태 | 전환·복구·재전환·재시작 후 SHA-256 |
| --- | --- | --- |
| `dispatch-state/2026-09-16.json` | 확정 155대, 주문 2,552, 박스 4,680, revision 9 | `ab2c1831b9594d5a6ba4d2b7459dee5e5e074361607f803c3e644ec33083b282` |
| `dispatch-state/2026-09-17.json` | 초안 149대, revision 1 | `7850925982e3ba24d13967092571fbe8583ead83e7243b99ab64ef8c4a96d4ea` |
| `resources/resources.sqlite` | schema v2, revision 0, 차량 31대 | `2a5301e08fcf8099ca9cd5f4c489a6adc58199a4a28da33706d1abb104e3527b` |

실제 자료의 격리 복사본에서 최대 물량일 2026-12-22의 주문 4,112건·차량 160대로 계산과 날짜 전환을 세 차례 반복했다. Kotlin 계산안은 기존 Node 계산안과 동일했고, Kotlin이 저장한 checkpoint를 기존 Node가 복원해 다음 명령도 처리했다. 최대 자료·배송지 목록을 함께 읽은 상태에서 동시 로그인도 확인했다.

native JVM은 `-Xmx256m`, systemd `MemoryMax=640M`이다. 복사본 반복 검증에서 최고 500,740,096 bytes(약 478 MiB), 메모리 상한 도달/OOM/kill 0, 서비스 재시작 0이었다. 이전 heap 128 MiB 제한은 최대 자료 반복에 부족해 채택하지 않았다. TEST의 실제 RAM은 약 908 MiB, swap 2 GiB이며 이는 측정한 단일 서버 검증 범위다. 동시 사용자 부하 시험은 별도다.

## 검증 증거

- Kotlin 컴파일·detekt·check·bootJar: 68개 테스트 통과.
- 프런트 타입·Oxlint·빌드: 오류 0, 기존 Anti Slop 경고 2개 유지. 프런트 테스트 274개와 빌드 산출물 검사 3개 통과.
- 루트 기존 회귀 검사: 508개 통과. 포크 출처 검사 7개도 통과했으며 source SHA/최초 포크 수를 변경하지 않고 검토한 현재 파일 해시만 갱신했다.
- 실제 JAR와 합성 Node golden 통합: 47개 통과. 계정 scrypt 호환, 등록/로그아웃/비활성 계정, 정확한 Origin, 여섯 명령, boot/revision 충돌, 묶음·진행 보호, 저장 실패/동시 변경/재시작, 잘못된 checkpoint와 source ID, Node 없는 native 게이트웨이를 검사했다.
- 배포 설정·패키지 무결성: 14개 통과. Push URL의 중복/잘못된 값 거부와 복구 순서도 포함한다.
- TEST 전환·이전 버전 복구·재전환·API/웹 재시작: 전체 상태·계정·자원·원본 조회 일치, Node API 중지 확인. 이전 Kotlin 세션은 401, 재로그인과 자료 복원 정상.
- 공개 HTTPS: 인증서 검증을 우회하지 않고 로그인 200, 비인증 업무 화면 302를 확인했다.
- 인증된 브라우저: 자원 31대, 확정 155대·주문 2,552건, 확정 운행의 완료 기록을 확인했다. 브라우저 오류 로그 0. 오늘 주문이 없는 경우 이력 조회 안내를 표시하며 데모로 전환하지 않는다.
- 임시 검토 계정은 Kotlin 오프라인 관리 CLI로 비활성화했다. 이미 발급된 세션 401과 브라우저 로그인 화면 복귀를 확인했고 기존 계정/초대는 변하지 않았다. 검토용 평문 비밀번호와 쿠키 파일 6개를 서버에서 제거했으며 로컬 비밀번호 파일과 임시 브라우저 탭도 정리했다.

로컬 실행 기록과 스크린샷은 ignored `.runtime/kotlin-state-deploy/`, `.runtime/new-stack-deploy/`에 있다. 이번 최종 결과는 `final-root-tests.log`, `final-web-check.log`, `final-provenance.log`, `final-runtime-proof.log`, `review-cleanup-proof.log`, `secret-cleanup-proof.log`로 확인한다. 서버의 검토 증거는 service 사용자 전용 `/var/lib/meatbox-demo/native-migration-review/`에 있고 실제 자료/계정 내용은 공개 보고서에 복사하지 않는다.

## 남은 경계

계정 JSON v1, 배차 checkpoint v2, 자원 SQLite v2는 기존 자료를 보존하기 위한 호환 저장 계약이다. 최종 테넌트 DB나 역할별 권한을 결정한 것으로 보지 않는다. 미트박스 공급자 API·취소/변경 계약, 실제 GPS·사진·알림 전달, 기사/고객 권한과 QA/운영 승격은 아직 구현·검증 범위 밖이다.

이관 당시 과거 데모 파일은 삭제 대상이었다. 후속 삭제 작업에서 진입점·링크·전용 의존성을 제거하고 운영 공용 코드와 출처 기록을 검증했다. 현재 업무 파일 책임은 [프로젝트 구조](project-structure.md)를 따른다.
