# 이관 Git 기준점 — 2026-10-05

기존 미커밋 이관·삭제 결과를 `codex/meatbox-native-baseline-20261005` 브랜치의 초안 PR로 고정한다. 기준 base는 `main`의 `c1f29a657678b51af888d6be2574103d89c1562f`다. 이 문서는 [삭제 완료 당시 중간 정리](migration-checkpoint-2026-10-05.md)의 첫 후속 작업 기록이다.

## 이번 단위

- 현행 프런트는 `apps/web`, 백엔드는 `services/api` 하나씩 유지한다. 책임별 파일 구조와 기존 자료의 호환 계약을 보존한다.
- 데모·중복 UI 194개 물리 삭제 경로와 출처 이력을 Git에 남긴다. Node golden 모델과 계정·배차·SQLite 호환 구현은 회귀 및 복구용으로 남긴다.
- `make check-release`를 전체 검사 진입점으로 추가하고, `make package-new-stack`은 이를 통과한 현재 JAR·웹을 포장한다. Git dirty scope는 프런트·Kotlin 소스를 포함한다.
- CI는 Ubuntu 24.04·Node 26.3.1·Java 21에서 lockfile 설치, 전체 검사, 패키지 생성을 실행한다. 공식 action 3개를 SHA로 고정했고 토큰 권한은 `contents: read`다. 배포·AWS 접근·외부 발송은 수행하지 않는다.
- `.gradle`, `.kotlin`, build, `.runtime`, 비밀값과 업무 자료는 Git 기준점에서 제외한다. Gradle Wrapper와 자산 라이선스는 소스에 포함한다.

## 검토에서 보완한 계약

1. 배포 후보 REVISION은 자신의 manifest Git head와 일치해야 한다. 이전 legacy SHA 검사는 별도로 수행하므로 다음 커밋의 후보도 배포할 수 있다.
2. 활성 배포는 정확한 `connected:<id>` 또는 `native:<id>`로 비교한다. rollout·rollback이 공유 lock을 사용하며 cutover 직전에 활성 포인터를 다시 확인한다. native에서 connected로 직접 rollout하는 경로는 거부하며 검토된 백업 rollback으로 Push·서비스 상태를 함께 복구한다.
3. 복구 전 immutable 대상·manifest·mode, 필수 설정·서비스 상태·Push 백업 존재 계약을 확인한다. rollout 자체의 자동 복구 입력도 변경 전에 검증한다. 업무 JSON/SQLite를 과거 백업으로 덮어쓰지 않는다.
4. 패키지는 경로·크기·해시와 `0644`/`0755` 권한을 검증한다. 권한 제거·확대와 허용하지 않은 manifest mode 회귀를 추가했다.
5. 로그인 next의 폐기된 `/scenario` 허용을 제거했다. 실제 HTTP 회귀가 수정 전에 `/scenario`로 이동하며 실패했고 수정 뒤 `/`로 정규화하며 통과했다.

## 검증

`make package-new-stack` 최종 고정 소스 검사와 패키지 생성이 통과했다.

| 검사 | 결과 |
| --- | --- |
| Kotlin compile·detekt·test·bootJar | 68 tests, 실패·오류·skip 0 |
| 프런트 typecheck·lint·build | 통과, 기존 warning 1 |
| 프런트 단위·gateway / 빌드 산출물 | 201 / 3 통과 |
| provenance·legacy golden | 28 통과 |
| 전체 Node·golden·배포·패키지 회귀 | 259 통과 |
| 실제 bootJar API 연결·재시작·장애 계약 | 47 통과 |
| 배포 / 패키지 focused 회귀 | 15 / 10 통과 |
| Shell·dash 구문 / ShellCheck / actionlint / 수정 소스 diff | 통과 |
| 실제 생성 archive 압축 해제 후 manifest 검증 | 통과 |

Kotlin 68개는 로그인 수정 후 전체 실행 결과다. 최종 Make에서는 변경 없는 Gradle 결과를 재사용했다. 로컬 검토 패키지는 커밋 전 `c1f29a657678-ee7715409cb82d01`, archive SHA-256 `09e88532cf2be756ab7b0061301e704c4738e18c945f9657c7d7936e913f0502`다. 새 커밋의 CI는 해당 Git 메타데이터로 별도 패키지를 만든다.

Git staged 공백 검사는 보존한 포크의 말미 빈 줄, 원본과 byte-identical인 OFL 라이선스 공백과 Gradle Windows wrapper CRLF를 허용한다. 이를 위해 소스·출처 해시를 바꾸지 않았다. 검사 묶음에 중복이 있으므로 수치를 합산하지 않는다. 기존 Anti Slop 경고 `apps/web/combined/source-viewer-plan.mjs:114` 한 건은 남아 있다. macOS의 lock 실패 분기는 mock flock로 검사했으며 Linux 호스트의 실제 동시 배포·서비스 복구 실행은 이번 소스 작업에서 검증하지 않았다.

## 독립 검토와 후속 범위

코드·보안 검토는 `APPROVE`이며 열린 CRITICAL/HIGH/MEDIUM/LOW는 0건이다. 구조 검토는 `WATCH`이고 blocker는 없다. 두 독립 레인의 합성 판정은 `COMMENT`다. 소스 기준점과 초안 PR을 만들 수 있으며 merge·배포 준비 완료로 판정하지 않는다.

구조 확인 사항은 새 도구/커밋의 TEST 실행 증거, 인증 HTML/문구 계약, 단일 호스트·writer 저장, Linux 실제 lock 경합, connected 모드의 별도 설치 `node_modules`다. 해당 설치 의존성은 immutable manifest 밖이며 connected 배포에서 lockfile `npm ci`로 다시 설치한다.

검토·검사 원본은 ignored `.runtime/release-baseline/`의 `code-review.md`, `architecture-review.md`, `final-validation.json`, `package-final-source.log`, `staged-whitespace-proof.json`에 보존한다. CI의 현행 결과는 PR checks에서 확인한다.

인증 오류 HTML의 문구와 프런트 해석은 현재 호환 계약으로 결합되어 있다. 문구·필드 변경 시 두 모듈과 회귀 검사를 함께 변경해야 한다. JSON/SQLite와 프로세스 내부 동기화는 TEST 단일 writer 범위이며 최종 DB·동시 writer·테넌트/역할 계약은 후속 결정이다.

이번 단위는 서버를 다시 배포하지 않았다. 삭제 작업에서 마지막으로 검증한 TEST 릴리스는 native `c1f29a657678-7cc16465b91dc217`이며 이는 당시 실행 증거다. 이번에 고친 로그인·패키징·배포 도구가 그 실행 버전에 적용됐다는 의미가 아니다. 기존 고정 릴리스의 복구 도구와 현재 저장소의 새 입력 계약을 섞어 사용하지 않는다.

다음 기능 단위는 SaaS 테넌트·역할·자료 접근과 최종 저장 계약이다. 공급자 주문·변경·취소, 실제 GPS·사진·알림, QA·운영 승격은 그 계약을 기준으로 이어간다. 기존 Push PR #28·#29는 수정하거나 병합하지 않았다.
