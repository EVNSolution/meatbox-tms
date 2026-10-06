# 기존 데모 삭제 계획

2026-10-05. 사용자의 정정에 따라 정리는 문서 기록뿐 아니라 **삭제 대상으로 확정한 기존 데모의 실제 제거**를 포함한다. 이번 단위는 파일·링크·빌드·실행 경로와 전용 회귀 검사를 함께 정리하고 결과를 중간 정리에 반영한다.

## 보존할 동작

운영 배차·관제·자원, 로그인·등록·세션, 디자인 기준 참조는 유지한다. Kotlin의 여섯 명령과 기존 확정 155대·초안 후보 149대·계정·자원 자료는 변경하지 않는다. 이전 TEST 실행 릴리스와 업무 백업은 복구 근거로 보존하며 삭제하지 않는다. 기존 Node의 계산·checkpoint golden 계약과 그에 필요한 모델은 비교/복구 근거로 남긴다.

삭제 전 프런트 274개와 실제 JAR의 native 게이트웨이 6개 검사를 실행해 현재 보존 동작을 확인했다. 삭제 후에는 제거된 화면의 접근 차단과 빌드/자산 부재, 남은 운영 페이지와 실제 JAR 계약을 함께 검사한다.

## 삭제 단위

1. `apps/web/`의 과거 기사·고객 데모, 다섯 scenario HTML과 전용 script/CSS/이미지·모델·테스트를 제거한다. 운영 코드에서 import하는 모델은 이름만으로 삭제하지 않는다.
2. 운영 화면의 떠다니는 시나리오 조작, 데모 화면 링크, manifest 404에 따른 시뮬레이션 WebSocket 전환을 제거한다. 누락 입력은 조회 오류로 드러낸다. 원본 주문의 날짜 조회/재연결/명령 확장과 확정 기록 projection은 유지한다.
3. 디자인 가이드는 현재 운영 컨트롤과 토큰을 설명하는 참조 화면으로 유지한다. 과거 합성 관제·고객·시나리오 시연 탭과 삭제 화면 링크는 제거한다. 가이드 자체의 명시적 디자인 표본과 운영 공용 의존성은 유지한다.
4. 원본 트리의 동일한 데모 UI·전용 테스트를 제거한다. 기존 계산/저장 모델, import되는 route 자료와 Node golden 엔진은 보존한다. 기존 서버는 업무 API·golden 비교 경계로 남기고 원본 운영 UI도 폐기해 프런트를 `apps/web` 하나로 통일한다. 원본 HTML/CSS/UI 전용 모듈을 제거하고 화면 handler는 410으로 닫는다. Node에서 import하는 공용 모델·portal 자산은 유지한다.
5. 포크의 원본 SHA·최초 수·변환 근거는 Git baseline으로 보존한다. 인벤토리에 삭제 disposition과 마지막 해시·이유를 기록하고 현재 유지 파일을 따로 검증한다. 존재하지 않는 파일을 현재 대상이라고 주장하지 않는다.

## 의존성과 fallback 분류

- 과거 고객/기사/scenario 링크·전용 자산·UI 도구: 사용자가 폐기한 데모 경로이므로 삭제한다.
- manifest 404 → 가상 WebSocket 전환: 과거 비교용 호환 동작이었지만 이번 제품에서 폐기한 경로다. 오류를 숨기는 전환을 새 프런트에 남기지 않는다.
- 날짜별 기존 schema를 읽는 Kotlin projection, Node golden engine·업무 모델과 복구 릴리스: 실제 자료 보존/복구 경계다. 데모 파일 이름과 관계없이 유지한다.
- 공급자 미확정 계약·새 UI 프레임워크·테넌트/DB 설계·Push worker 변경은 이번 삭제에 포함하지 않는다.

## 실행과 검토

삭제 전에 현재 미커밋 프런트 소스를 ignored 로컬 백업에 보존한다. 삭제 목록은 import/URL/빌드 입력과 실제 사용처를 확인한 뒤 확정한다. 프런트 편집과 원본/서버 편집은 파일 소유자를 나누고, 루트가 라우팅·인벤토리·패키지·결과 통합을 담당한다. 별도 읽기 검토로 계획과 최종 변경을 확인한다.

현재 TEST는 native이고 삭제 URL은 이미 410이다. 새 빌드에도 데모가 물리적으로 포함되지 않도록 타입/lint/빌드·산출물·회귀·API 검사를 완료한 다음 같은 TEST 배포 경로로 적용·복구·재적용·인증된 운영 화면을 확인한다. 업무 자료는 검증을 위해 수정하지 않는다. QA·운영 배포는 하지 않는다.

완료 후 삭제 수·남은 공유 파일·검증·TEST 릴리스·복구 경로를 결과 문서와 중간 정리에 포함하고 다음 지시를 기다린다.

## 삭제 전 소스 백업과 복원

미커밋 `apps/web/` 전체(소스·테스트·인벤토리·공용 자산)를 `.runtime/demo-removal/frontend-source-before.tar.gz`에 보존했다. `node_modules`와 내부 `.runtime`은 제외했다. 파일 권한은 0600이며 SHA-256은 `62049a418a990ba4d281c190a3196aaf38451ba64f4986fd0c549136cbe6e3ce`이다. 기존 tracked 원본은 Git `c1f29a657678b51af888d6be2574103d89c1562f`에 남아 있다.

복원이 필요하면 저장소 루트에서 아래와 같이 별도 디렉터리에 추출하고 현재 작업과 비교한 뒤 필요한 파일만 복원한다. 현재 트리를 통째로 덮어쓰거나 다른 변경을 되돌리지 않는다.

```sh
shasum -a 256 .runtime/demo-removal/frontend-source-before.tar.gz
mkdir -p .runtime/demo-removal/restore-before
tar -xzf .runtime/demo-removal/frontend-source-before.tar.gz -C .runtime/demo-removal/restore-before
diff -qr .runtime/demo-removal/restore-before/apps/web apps/web
```

원본으로 복구했다면 삭제 전 프런트 274개 검사와 실제 JAR native 게이트웨이 6개 검사를 다시 통과시켜야 한다. 실행 명령과 삭제 전 결과는 `.runtime/demo-removal/frontend-before.log`, `.runtime/demo-removal/native-before.log`와 프로젝트 검사 스크립트에 남긴다. TEST 복구에는 기존 immutable 릴리스와 배포 스크립트의 backup 경로를 사용하며 이 소스 백업을 업무 데이터 복구에 사용하지 않는다.
