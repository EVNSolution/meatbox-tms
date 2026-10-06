# 기존 데모 실제 삭제 결과

2026-10-05, Asia/Seoul. 사용자가 요청한 정리는 **파일 삭제**까지 포함한다. 194개 파일을 삭제하고 TEST 전환·이전 버전 복구·최종 재전환과 인증된 화면 확인을 완료했다. 현재 작업 기준은 [중간 정리](migration-checkpoint-2026-10-05.md)에 남긴다.

## 삭제한 범위

중복 경로를 제외해 **194개 파일**을 실제 삭제했다. 원본·전용 회귀/도구 138개와 포크·fallback 전용 59개 사이에 동일한 회귀 파일 3개가 포함되어 있다. `apps/web/` 내부의 물리 삭제는 56개다. 전체 경로와 출처 해시는 [삭제 인벤토리](demo-removal-inventory.json)에 기록했다.

- 고객·기사 데모 HTML, 전용 모델·CSS·스크립트·테스트와 전용 사진·지도 핀.
- 다섯 scenario HTML, 공개 scenario 스크립트·CSS, 떠다니는 조작 패널과 전용 모델·검사.
- 원본 중복 운영 UI와 `workspaces/jiin-ui` 합성 화면. 운영 UI의 소유권은 `apps/web` 하나로 통일했다.
- sanghyun 독립 데모 서버·package·실행 설정·생성 도구와 과거 브라우저 검사.
- 프런트의 WebSocket 상태 어댑터·manifest 404 fallback 정책. 날짜별 원본 조회 실패는 가상 상태로 바뀌지 않고 조회 오류와 재시도로 표시한다.

운영 화면에는 배차·배송 관제·자원 메뉴 3개를 유지하고 기존 CSS로 헤더/탐색을 구성했다. 디자인 가이드는 토큰·현재 컴포넌트의 고정 예제만 남겼다. 운영 지도는 원본 좌표만 사용하며 scenario 좌표 API에 의존하지 않는다.

## 보존한 경계

Kotlin API의 업무 동작·저장과 실제 확정 155대·초안 후보 149대·자원 자료를 보존했다. 기존 계정·초대의 모든 항목은 동일하고, 이번 검토용 임시 계정만 추가한 뒤 비활성화했다. Node golden 계산·저장 모델, core에서 import하는 공용 모델 7개, portal 공용 로고·폰트·라이선스, scenario `src`와 ETA golden·설계 원본의 출처 기록은 유지했다. 이것은 별도 제품 프런트가 아니라 비교/복구 근거다.

이전 immutable TEST 릴리스·데이터 백업과 로컬 삭제 전 소스 백업은 보존한다. 소스 복원 절차와 백업 SHA는 [삭제 계획](demo-removal-plan.md)에 있다. 삭제된 페이지를 새 제품으로 다시 구현하거나 QA·운영 환경을 생성하지 않았다.

## 출처·산출물

`fork-inventory.json` schema 3은 최초 142개 소스와 163개 매핑, authored 21개의 이력을 그대로 남긴다. 현재는 매핑 106개와 authored 19개를 유지하고 매핑 57개·authored 2개를 removed로 기록했다. 원본 baseline은 127개가 removed, 15개가 유지 상태다. 삭제 사유·마지막 해시와 Git baseline SHA를 보존하고 실제 유지 파일과 삭제 부재를 검사한다.

Vite HTML은 운영·가이드·로그인·등록 **4개**다. 새 패키저는 baseline Git 정보를 기록하되 현재 working tree의 regular file 바이트만 포함하므로 `HEAD`에서 삭제 파일을 다시 복구하지 않는다. 새 패키지에서 삭제 원본 127개와 데모 HTML/전용 자산 부재, Node golden 모델 보존을 확인했다.

최종 활성 릴리스: `c1f29a657678-7cc16465b91dc217`.
Archive SHA-256: `e93121e09c260304fa004e8dbee835ae43c9adc8a52c7bf197b5d59843c98bdc`.
API JAR SHA-256: `9fed18fdad5d1f451503dd6aa457e8836989dc79a2c48c55fe8453bfe93d3b0c`로 직전 native 이관과 동일하다.

배포 후 검사에서 도구 파일을 `current` symlink로 실행하면 CLI 검사를 건너뛰는 문제를 발견해 실제 경로 비교로 수정했다. script symlink 실행·파일 변조 실패·릴리스 디렉터리 symlink 거부를 회귀 검사로 고정했다. 서버에서도 실제 `verified` JSON 출력과 릴리스 ID를 확인했다. 검사 대상 디렉터리는 다음과 같이 실제 경로로 지정한다.

```sh
release=$(readlink -f /opt/meatbox-tms/current)
sudo node /opt/meatbox-tms/current/tools/package-new-stack.mjs --verify-installed "$release"
```

## 검증

| 확인 | 결과 |
| --- | --- |
| 프런트 typecheck / lint / Vite build | PASS, lint 오류 0·기존 경고 1개 |
| 프런트 단위·gateway | 201/201 PASS |
| 빌드 산출물·보호 접근·자산 | 3/3 PASS, HTML 4개 |
| 기존 API/golden/저장·회귀 | 249/249 PASS |
| 출처·삭제 부재·원본 Git 해시 | 7/7 PASS, 위 249개에 포함 |
| 실제 JAR API 통합 | 47/47 PASS |
| 배포/패키지 | 15/15 PASS, 일부 루트 회귀와 중복 |
| 로컬 native 브라우저 | 메뉴·주문·관제·자원·guide-only 확인, 콘솔 오류/경고 0 |
| TEST 전환·복구·최종 재전환 및 실자료 대조 | PASS, 전체 상태·원본 조회·기존 계정/초대 일치 |
| 인증된 TEST 브라우저 | 확정·초안·관제·자원·guide-only 확인, 콘솔 오류/경고 0 |
| 공개 HTTPS | 인증서 검증 PASS, 보호 화면 302·폐기 URL 410 |

기존 Anti Slop 경고는 `combined/source-viewer-plan.mjs:114`의 filter/map 한 건이다. 기사 데모 삭제로 다른 한 건은 없어졌다. 새 경고나 API 의존성은 추가하지 않았다.

## TEST 실행과 복구 근거

TEST 한 대(`i-03d1f27429c948b7d`, ap-northeast-2)만 변경했다. Caddy HTTPS → 프런트 게이트웨이 4173 → Kotlin API 8081이다. API·웹은 active, NRestarts 0이며 기존 업무 Node는 inactive/disabled, PID 0이고 3001 listener가 없다. Push worker는 PID 167808/NRestarts 0을 유지했고 검증용 메시지를 발송하지 않았다. JVM heap 256 MiB·systemd 상한 640 MiB를 유지했다.

| 보존 자료 | 상태 | 최종 SHA-256 |
| --- | --- | --- |
| `dispatch-state/2026-09-16.json` | 확정 155대·2,552주문·4,680박스·revision 9 | `ab2c1831b9594d5a6ba4d2b7459dee5e5e074361607f803c3e644ec33083b282` |
| `dispatch-state/2026-09-17.json` | 초안 후보 149대·배정 148대·2,423주문·4,636박스·revision 1 | `7850925982e3ba24d13967092571fbe8583ead83e7243b99ab64ef8c4a96d4ea` |
| `resources/resources.sqlite` | schema v2·revision 0·31대 | `2a5301e08fcf8099ca9cd5f4c489a6adc58199a4a28da33706d1abb104e3527b` |

최종 버전을 적용한 후 `/var/backups/meatbox-tms/20261005T125338Z-230551`로 이전 native 릴리스 `c1f29a657678-e6d5ebd59edd91ee` 복구와 health·로그인·전체 자료 일치를 확인했다. 최종 재전환 백업은 `/var/backups/meatbox-tms/20261005T125900Z-231494`다. 이전 immutable 릴리스의 MANIFEST SHA `1b69689c3a25d6a4f505f4f7eb75413497188e43b164101149852114125e7d97`도 동일하다. 초기 검토 후보 `509a365b9acc63ab`는 활성 버전이 아니며 복구 증거로만 남긴다.

아래는 현재 저장소의 검토된 복구 도구를 사용하는 명령이다. 이 도구의 입력은 `mode:releaseId`이며 이번 Git 기준점 작업에서는 TEST에 새 도구를 배포하지 않았다. 기존 고정 릴리스에 포함된 도구는 이전 ID 입력 계약을 사용하므로 섞어 실행하지 않는다. 실행 직전에 활성 모드·ID를 다시 확인하며, 일치할 때 코드·설정·서비스를 이전 native로 복구한다. 현재 업무 자료를 백업 자료로 덮어쓰지 않는다. 복구 후 API health와 웹 readiness를 기다린 뒤 다시 로그인하고 상태를 조회한다.

```sh
sudo sh /path/to/reviewed-source/deploy/new-stack/rollback.sh \
  /var/backups/meatbox-tms/20261005T125900Z-231494 \
  native:c1f29a657678-7cc16465b91dc217
```

검토 계정은 Kotlin 오프라인 CLI로 비활성화했고 발급된 세션의 401과 브라우저의 로그인 화면 복귀를 확인했다. 서버의 평문 계정 파일·쿠키 5개, 로컬 평문 계정 파일·SSH 키 쌍을 제거했다. 초대 평문은 등록 직후 제거했다. 임시 브라우저 탭과 SSH master를 종료했으며 로컬 검토 포트 3001·4173·8081에 listener가 없다. 서비스 사용자 전용 검토 자료와 root 전용 업무 백업은 보존했다.

## 작업 기준점

`main` HEAD는 `c1f29a657678b51af888d6be2574103d89c1562f`다. 이번 이관과 삭제는 아직 미커밋 작업 트리이며 실제 산출물의 내용 해시로 릴리스를 구분한다. 기존 Push PR #28·#29는 변경하지 않았다. 다음 지시가 오기 전에는 추가 구현·삭제·배포·커밋을 시작하지 않는다.

검증 로그와 스크린샷은 ignored `.runtime/demo-removal/`에 있다. 주요 증거는 `root-tests-final.log`, `web-check.log`, `api-tests.log`, `package-tests-final.log`, `final-rollback-proof.log`, `reapply-final-proof.log`, `runtime-final-proof.log`, `https-final-proof.json`, `live-browser-proof.json`, `review-cleanup-proof.log`, `secret-cleanup-proof.log`, `local-cleanup-proof.json`과 `live-guide.png`다. 업무 자료나 검토 비밀번호·쿠키는 이 문서/인벤토리/배포 패키지에 포함하지 않는다.
