# TEST 무중단 전환·세션 유지 검증 기록

2026-10-13, Asia/Seoul. 작업·확인: 자동화 세션(검토 계정은 임시 발급 후 비활성화). 대상은 TEST 한 대(`i-03d1f27429c948b7d`, `3.36.96.156`)다. 측정은 임시 검토 계정으로 로그인한 쿠키로 공개 HTTPS `/api/session`을 1초 간격 요청해 상태 코드를 기록했다. 로그 원본은 작업 세션의 접근 제한 임시 디렉터리에만 있으며 수치만 옮긴다.

## 대상과 결과

- 이전 실행 SHA / 후보 SHA / 실제 실행 SHA: `b66b5de`(리허설 전 `8cee5a0`) / `58e01fb` / `58e01fb`
- 변경 목적: 배포 중 502/503과 로그인 소실 제거. 사용자에게 달라지는 동작은 배포 뒤에도 로그인 상태가 남고 요청이 실패하지 않는 것이다.
- 최종 판정: **전환**. 새 rollout의 세 측정 모두 5xx·연결 실패 0건이다. 세션 유지는 이전 릴리스가 세션 파일을 쓰지 않아 `58e01fb` 배포에서는 확인할 수 없었고, 다음 `4312687` 배포에서 로그인 상태가 그대로 유지됐다.

## 측정

| 구간 | 전환 방식 | 표본 | 200 | 401 | 502 | 503 | 연결 실패 | 비고 |
|---|---|---|---|---|---|---|---|---|
| 기준선: `8cee5a0` 자동 배포(run 38367277865), 08:04:18~08:16:17 | 기존 stop→start | 662 | 289 | 360 | 6 | 7 | 0 | 08:09:34~08:09:47 13초 실패, 08:09:48부터 세션 401 |
| 리허설: `b66b5de`를 PR #48의 rollout.sh로 수동 전환(legacy→green), 08:24:48~08:28:47 | blue/green | 240 | 35 | 185 | 0 | 0 | 0 | 08:25:20 Caddy reload 시점에 세션 401(구 릴리스가 세션 파일 미기록) |
| `58e01fb` 자동 배포(run 38369919190), 08:28:47~08:39:46 | blue/green(green→blue) | 603 | 536 | 67 | 0 | 0 | 0 | 08:33:13부터 401, 재로그인 뒤 200. 구 릴리스가 세션 파일 미기록 |
| `4312687` 자동 배포(run 38371166557), 08:34:46~08:44:49 | blue/green(blue→green) | 552 | 552 | 0 | 0 | 0 | 0 | **로그인 유지**: 전환 창 08:43:40~08:44:20의 36표본 모두 200, 배포 뒤 `/api/session`·`/combined/` 200 |

`4312687` 자동 배포(main CI 38370951602, Gradle detekt·compileKotlin·test FROM-CACHE로 1분 44초)의 단계 시간: snapshot 0.6초, transfer 8.3초, rollout 26.6초, 총 47.6초. API 기동 08:43:49 → 준비 08:43:58, web 08:43:59, Caddy reload 08:44:00, 구 슬롯 정지 08:44:06~08:44:09.

`58e01fb` 자동 배포의 단계 시간: snapshot 1.3초, transfer 10.4초, rollout 29.2초, 총 52.8초. rollout 안에서 API 기동 08:33:01 → 준비 08:33:10, web 기동 08:33:11, Caddy reload 08:33:12, Push Lab 재시작 08:33:12, 구 슬롯 정지 08:33:18~08:33:23.

## 전제와 보존 기준

- 적용 설정: 슬롯 blue(web 4173, API 8081)·green(web 4174, API 8082), `/etc/meatbox-tms/active-slot`, `slot-blue.env`/`slot-green.env`, template unit `meatbox-api@`/`meatbox-web@`. Caddy fallback 한 줄만 바뀐다. Push Lab 세션 URL은 활성 슬롯 API 포트를 가리킨다.
- 자료: `access.json` sha256 `64fc47d3…0a46d`(임시 검토 계정 추가 뒤), `resources.sqlite` sha256 `2a5301e0…3527b` 전후 동일, `dispatch-state` 2개 파일 보존. 세션 파일 `/var/lib/meatbox-demo/sessions.json`은 `meatbox-demo:meatbox-demo 0600`, 토큰 digest만 담는다.
- 백업: `/var/backups/meatbox-tms/20261013T082504Z-285279`(리허설), `/var/backups/meatbox-tms/20261013T083256Z-286256`(자동 배포). 서비스 중 원자적 교체 파일 복사와 SQLite `VACUUM INTO` 스냅샷, SHA256SUMS 검증.
- 쓰기 통제: Caddy reload 전 받은 진행 중 요청만 구 슬롯이 처리하고, 연결 drain 뒤 구 슬롯을 멈춘다. 공유 release lock 유지.

## 증거

| 층위 | 확인 방법 | 결과 | 미확인 범위 |
|---|---|---|---|
| 소스·테스트 | PR #48 CI 38369054982, main CI 38369514013, 로컬 `make check-release` | 성공. Kotlin 83, 프런트 277, 루트 267, 실제 JAR 계약 55 | — |
| 불변 후보 | artifact `58e01fb2d7a7-3427cfbe1e1e4a4e`, verify-ci-artifact 신뢰 기록 | 일치 | — |
| 서버 실행 | `/opt/meatbox-tms/current`·`slots/blue` → `58e01fb…`, `deployment-mode native 58e01fb…`, `active-slot blue`, `meatbox-api@blue`/`meatbox-web@blue` active, NRestarts 0, health UP | 일치 | 메모리: 두 JVM 겹침 구간 free 약 130MB+swap |
| 자료 보존 | sha256·파일 수 전후 비교 | 동일 | — |
| 인증·HTTP | 임시 계정 로그인 303, `/api/session` 200, `/combined/` 200, 비인증 `/combined/` 302 | 정상 | 역할 권한 없음(기존 제한) |
| 브라우저 | 미수행(HTTP 계약으로 대체) | — | 화면 렌더링 |

## 복구와 인계

- 복구: `sudo /opt/meatbox-tms/current/deploy/new-stack/rollback.sh <backup> native:<active-id>`가 환경 파일을 복원하고 같은 blue/green rollout으로 이전 릴리스를 반대 슬롯에 올린다. 세션 유지 이전 릴리스로 복구하면 세션은 사라진다.
- 남은 제한: 서버 메모리 908MB에서 두 JVM이 약 20초 겹친다. 폐기한 고정 unit `meatbox-api.service`는 stopped(failed 표시)·disabled 상태로 남아 있고 이전 세션의 transient `meatbox-*-candidate` unit도 failed 표시로 남아 있다(`systemctl reset-failed`로 정리 가능).
- 다음 확인: 완료 조건(로그인 유지, 배포 중 5xx·연결 실패 0건, 로그아웃·만료 세션 미복원)을 모두 측정했다. 로그아웃·만료·비활성화 미복원은 `SessionPersistenceTest`와 실제 JAR 계약 검사가 보장하고, 배포 뒤 로그아웃 쿠키의 401을 실서버에서 확인했다.
