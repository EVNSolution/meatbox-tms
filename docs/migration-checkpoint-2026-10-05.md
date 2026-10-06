# 미트박스 이관 중간 정리

후속 지시 “다음작업 시작”에 따른 Git 기준점·초안 PR 작업은 [후속 기록](release-baseline-2026-10-05.md)에 있다. 아래 브랜치·미커밋·대기 상태는 삭제 완료 당시의 기록이다.

2026-10-05, Asia/Seoul. 사용자의 **“중간 정리, 및 다음 작업 대기”**와 **“정리는 삭제까지 포함”** 지시에 따라 기존 데모 실제 삭제와 TEST 검증까지 마쳤다. 다음 지시를 기다리며 추가 구현·삭제·배포·커밋·외부 연동을 자동으로 시작하지 않는다.

## 확정한 방향

- 프런트는 TypeScript 기반 단일 패키지 `apps/web/`다. 화면·모델·API 요청·공통 디자인을 책임별 파일로 관리한다.
- 백엔드는 단일 Kotlin/JVM·Spring Boot 프로젝트 `services/api/`다. 업무별 패키지에서 요청·계산·저장을 나눈다.
- 현재는 TEST 서버 한 대만 사용한다. QA·운영 서버 생성과 승격은 아직 하지 않았다.
- 고객·기사·시나리오 데모는 폐기했다. 실제 확정 155대·초안 후보 149대의 기록과 자원 자료는 보존한다.

## 완료한 이관과 삭제

| 구분 | 완료 내용 |
| --- | --- |
| 도구·규칙 | Attention-kind, 구현 단위 지침, 고정한 Anti Slop 규칙, 프런트 타입/lint와 Kotlin detekt 검사를 마련했다. |
| 단일 프런트 | 운영 배차·배송 관제·자원 메뉴 3개와 토큰·컴포넌트 참조 가이드를 유지했다. 원본 중복 운영 UI를 제거해 제품 프런트 소유권을 통일했다. |
| Kotlin API | 로그인·등록·로그아웃·세션·계정/초대 저장, 원본 조회, 자원 저장, 날짜별 배차 명령 6종과 확정 기록 복원을 이관했다. |
| 실제 삭제 | 중복을 제외한 194개 파일을 삭제했다. 고객·기사·scenario HTML/전용 코드·자산·테스트, 독립 데모 서버/실행 설정, jiin 합성 UI와 WebSocket fallback을 제거했다. |
| 빌드·접근 | Vite HTML은 운영·가이드·로그인·등록 4개다. 폐기 URL·scenario API·시뮬레이션 WebSocket은 410이며 배포 산출물에도 삭제 파일이 없다. |
| 출처·복구 | 최초 포크 이력을 schema 3에서 active/removed로 구분했다. 공용 golden 모델·원본 Git 해시·삭제 전 소스 백업·이전 immutable 릴리스를 보존했다. |
| TEST | 삭제 버전 전환·이전 native 복구·최종 재전환과 실제 화면 확인을 완료했다. 기존 업무 Node API는 중지·비활성화 상태다. |
| 검토 정리 | 임시 계정 비활성화·기존 세션 401·브라우저 로그인 복귀를 확인하고 평문 계정/쿠키·접속 키·임시 탭·SSH master를 정리했다. |

삭제 경로 194개와 이유·해시는 [삭제 인벤토리](demo-removal-inventory.json)에 있다. `apps/web/`의 물리 삭제는 56개다. 원본·전용 회귀/도구 138개와 포크·fallback 59개 사이에 3개가 겹친다. Node golden 계산·저장 엔진, core 공용 모델 7개, portal 로고·폰트·라이선스와 ETA 비교용 `src`/golden은 실제 계약 비교와 복구를 위해 남겼다.

## 최종 TEST 실행 상태

이번 삭제 작업에서 다시 확인한 증거이며 직전 이관 결과를 현재 상태로 대신하지 않았다.

- 활성 릴리스: `c1f29a657678-7cc16465b91dc217`, native.
- 경로: Caddy HTTPS → 프런트 게이트웨이 4173 → Kotlin API 8081. API·웹은 active/enabled, NRestarts 0이다.
- 기존 업무 Node `meatbox-gateway`: inactive/disabled, PID 0, 3001 listener 없음.
- Push worker: PID 167808/NRestarts 0 유지. 기존 allowlist 유지, 익명 401·유효한 미등록 계정 403. 검증용 메시지는 발송하지 않았다.
- 확정 2026-09-16: 155대·주문 2,552건·박스 4,680·revision 9.
- 초안 2026-09-17: 후보 149대·배정 148대·주문 2,423건·박스 4,636·revision 1.
- 자원 SQLite v2: 차량 31대·revision 0. 두 날짜의 checkpoint와 DB 해시는 전환·복구·재전환·최종 계정 정리 후 동일하다. 기존 계정/초대의 각 항목도 동일하다.
- JVM heap 256 MiB·systemd 상한 640 MiB 유지. 직전 격리 자료 반복 시험의 최대 4,112주문·160차량/약 478 MiB/OOM 0 결과는 [이관 당시 기록](kotlin-state-migration-result.md)에 있으며 이번 삭제에서 부하 시험을 다시 실행한 것은 아니다.

최종 archive SHA는 `e93121e09c260304fa004e8dbee835ae43c9adc8a52c7bf197b5d59843c98bdc`다. API JAR SHA `9fed18fdad5d1f451503dd6aa457e8836989dc79a2c48c55fe8453bfe93d3b0c`는 직전 이관과 동일하다. 최종 재전환 백업 `/var/backups/meatbox-tms/20261005T125900Z-231494`는 이전 native `c1f29a657678-e6d5ebd59edd91ee`로 코드·설정을 복구하는 근거다. 현재 업무 자료는 복구 시 덮어쓰지 않는다. 실제 명령과 자료 해시는 [삭제 결과](demo-removal-result.md)에 있다.

## 검증과 소스 상태

삭제 후 프런트 typecheck/lint/build와 단위·gateway 201개·산출물 3개, 루트 회귀 249개, 실제 JAR API 통합 47개, 출처 검사 7개, 배포/패키지 15개가 통과했다. 검사 목록에는 중복이 있으므로 합산하지 않는다. Kotlin 68개는 직전 동일 JAR의 검증 결과이며 Kotlin 소스를 이번에 변경하지 않았다. 기존 Anti Slop 경고는 `apps/web/combined/source-viewer-plan.mjs:114` 한 건 남아 있다.

인증된 TEST 브라우저에서 확정·초안·배송 관제·자원 31대·guide-only를 확인했고 콘솔 오류/경고는 0이다. 공개 HTTPS 인증서 검증, 보호 화면 302와 폐기 URL 410도 통과했다. 임시 계정의 평문/쿠키 5개는 서버에서 제거했으며 로컬 비밀번호 파일·SSH 키 쌍·임시 탭·접속 세션도 정리했다. 로컬 3001·4173·8081에는 listener가 없다.

- 저장소: `/Users/jiin/Documents/Files/03_Work_EVnSolution/01_Repos/07_MEATBOX_TMS/meatbox-tms`.
- 브랜치: `main`, HEAD `c1f29a657678b51af888d6be2574103d89c1562f`.
- 이관·삭제 소스와 문서는 **아직 미커밋 작업 트리**다. 배포는 Git SHA와 산출물 내용 해시로 식별하며 커밋/PR 게시 완료로 보지 않는다.
- 열린 Push PR #28·#29는 변경하거나 병합하지 않았다. 별도 QA·운영 배포도 하지 않았다.

## 남은 작업

다음 지시에 따라 해당 범위만 재개한다. 이번에 폐기한 데모를 새로운 고객·기사 화면의 계약으로 사용하지 않는다.

1. 현재 변경의 최종 검토와 커밋/PR 기준점 확보.
2. SaaS 테넌트·역할·자료 접근 계약과 최종 저장 구조 결정. 현재 JSON/SQLite는 기존 자료 보존용 호환 계약이다.
3. 미트박스 공급자 주문·변경·취소 API 계약과 입력 어댑터 연결.
4. 실제 GPS·사진·알림과 고객·기사 권한을 공급자/장치 계약에 맞춰 구현·검증.
5. QA·운영 환경, 승격·동시 사용자 부하·운영 복구 검증.

## 이어서 읽을 문서

- [실제 삭제·검증·TEST 복구](demo-removal-result.md), [전체 삭제 목록](demo-removal-inventory.json), [삭제 전 백업과 소스 복원](demo-removal-plan.md)
- [기능별 파일 책임](project-structure.md), [구조와 환경 결정](new-stack-architecture.md), [개발·검사·계정 관리](new-stack-development.md)
- [Kotlin 이관 당시 결과](kotlin-state-migration-result.md), [이관 범위](kotlin-state-migration-plan.md)

최종 증거는 ignored `.runtime/demo-removal/`에 있다. 이전 이관 증거는 `.runtime/kotlin-state-deploy/`와 `.runtime/new-stack-deploy/`에 보존한다. 재개할 때 브랜치·작업 트리·활성 릴리스·자료 revision을 다시 확인한다.
