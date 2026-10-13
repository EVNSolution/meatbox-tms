# 포크 프런트 디자인·구조 개선

2026-10-05, Asia/Seoul. 사용자가 디자인 레퍼런스 일치와 관리하기 쉬운 코드·파일 분리를 요청했다. 현재 미커밋 환경·포크 작업을 보존한다. 기존 UI·업무 writer·실자료·원격 배포는 변경하지 않는다.

## 요구와 근거

- 디자인 정본은 저장소 `DESIGN.md` 하나다. 공식 로고·보존 자산 출처와 현재 제품 계약을 우선한다. [`docs/history/workspace-2026-09/previews/terminal-view`](history/workspace-2026-09/previews/terminal-view/)는 읽기 전용 참고다.
- 실제 제품은 브랜드 빨강, 액센트 분홍, Pretendard, 56px 헤더, 44px 조작, 6px 기본 반경이다. 포크 가이드는 분홍 브랜드·3px 반경·40px 입력·예전 메뉴를 보여 주고 인증 CSS도 3px 반경과 뒤에서 덮는 과거 스타일을 갖고 있다.
- 운영 CSS 1,843줄, 참조 CSS 1,782줄에는 foundation·shell·controls·workspace·preview·responsive·composition 책임이 섞였다. 단순 중복률만으로 합치면 의도한 화면 표현을 잃는다.
- 관제 `vehicle-control.mjs`는 배차 UI `order-planning.mjs`에서 기본 지도 함수를 가져온다. 두 기능이 실제 공통 지도 모듈을 직접 사용하도록 분리한다.
- 새 프런트 자체 기준선: 모델·인증·게이트웨이 250개 통과. 원본 142개·현재 대상 SHA·기존 writer 공유 모델 byte 동일 검사도 유지한다.

## 선택과 작업 범위

선택 A는 폴더 전체 이동과 UI 재작성이다. 이름 변경 위주의 대량 import 수정, 상태·명령과 뷰의 동시 변경 때문에 이번 목표보다 위험이 크다. 선택 B는 실제 공통 책임을 추출하고 기존 파일을 보존한 채 CSS를 연속 규칙 단위로 나누는 방법이다. **B를 적용한다.** 새 패키지·프레임워크·의존성·barrel export를 도입하지 않는다.

1. 업무 동작을 기존 회귀로 잠그고 기본 지도 설정·marker·정리 동작은 추출 전 테스트로 보강한다.
2. 운영·참조 CSS를 완전한 연속 rule 구간으로 분리하고 기존 cascade 순서를 유지한다. 추출 직후 펼친 CSS와 기존 파일이 동일함을 확인한다.
3. 작은 공통 theme에 브랜드·서체·색·기본 치수 소유권을 둔다. 제품·인증·가이드가 이를 사용한다. 공개 인증 theme은 UI 코드·업무 자료를 포함하지 않으며 게이트웨이의 정확한 공개 allowlist와 산출물 검사를 갱신한다.
4. 가이드는 현행 메뉴·날짜 툴바·토큰·조작·포커스 표본을 실제 제품 컴포넌트로 보여 준다. 과거 단말 합성 시나리오는 참조로 구분한다. 인증의 사용하지 않는 landing CSS와 중복 덮어쓰기를 제거한다.
5. 공통 지도 함수만 `src/shared/maps`로 옮긴다. 관제와 배차가 직접 사용하며 기존 entry·명령·캐시·증빙 URL 수명은 그대로 둔다.
6. 의도한 개선의 target SHA·분리 매핑·변환 이유를 갱신한다. 원본 commit/SHA·142개 coverage·회귀 assertions·writer 공유 모델 동등성 검사를 약화하지 않는다. 추가된 authored 파일과 원본 파생 fragment를 구분한다.

## 상태·fallback 경계

업무 상태 쓰기 소유자는 기존 Node 한 곳이다. manifest 없는 레거시 참조 시뮬레이션, source 상태 실패, revision 충돌, 세션 실패는 현재 근거와 회귀가 있는 호환/실패 경계로 유지한다. 이번 CSS·지도 추출에서 새 silent fallback·실패 무시·시연 상태 대체를 추가하지 않는다. 실제 GPS·ETA·알림·SaaS 인가를 구현했다고 표현하지 않는다.

운영 rail 92/72px, 고객·기사의 rail 없음, 390×780 검토 프레임, 모바일 카드·sheet의 별도 반경은 의도한 문맥이다. 기존 시나리오 reference를 같은 운영 레이아웃으로 바꾸지 않는다. 지도 attribution과 정체성이 다른 로고·앱·기능 아이콘도 보존한다.

## 완료 조건과 검증

- CSS import 순서·지도 설정·marker lifecycle·모델·API 연결·보호 자산·인증 독립 번들 검사 통과.
- 제품과 가이드의 브랜드·실제 font·입력/버튼 높이·기본 반경이 같고 가이드에서 현행 운영 메뉴·날짜 툴바를 확인할 수 있음.
- 1440/390/320px에서 가로 넘침·헤더 두 줄화·조작 가림 없음. 가이드 pointer 클릭은 링크 focus를 유지하며 keyboard/hash 기록 전환은 제목으로 이동.
- 합성 자료의 배차 계산→확정→기사/관제/고객 조회와 자원 편집/취소, 날짜 전환·빈 상태를 브라우저로 확인. 시나리오·모바일의 의도한 차이를 별도 기록.
- code 작성자와 별개로 계획·코드·실제 화면을 검토하고 시각 판정과 이미지를 보존한다. `make check-new-stack`, 루트 `npm test`, `git diff --check` 및 원본 보호 검사로 완료 판정.

## 적용·검토 결과

독립 계획 검토 APPROVE 후 적용했고, 작성자와 다른 검토자가 코드·실제 이미지에서 추가 차단 문제 없음으로 판정했다.

- 공통 `public/theme.css`에 기존 제품 색·Pretendard·44px 조작·56px 헤더·6px 기본 반경을 모았다. 인증의 theme 의존성은 `portal.css` import로 제공해 기존 Node native 오류 응답에도 유지했다.
- CSS 16개 책임별 fragment의 최초 재결합은 원본과 byte 동일했다. 이후 명시한 theme 정렬만 적용했다. 날짜·집계 CSS는 원본 268–323줄과 byte 동일하게 추출했다.
- 기본 지도 3개 함수와 marker formatter는 원본 동등성을 유지했다. 기존 exports도 유지하며 관제는 공통 모듈을 직접 사용한다. 기존 모델 회귀 assertions는 바꾸지 않았다.
- 가이드는 실제 날짜 컴포넌트·동적 theme 값·현행 업무 링크를 보여 준다. 날짜 표본은 빈 날짜에서 집계를 숨기고 과거에는 읽기 전용임을 표시하며 업무 요청을 보내지 않는다. 기존 세션 GET 확인은 유지한다.
- 독립 검토의 modifier 클릭 focus, native 인증 오류 theme 누락, 가이드 탭 42px, floating 시나리오 패널 가림을 수정했다. 가이드에서만 패널을 숨기고 표본 화면에서 다시 표시·위치를 제한한다. 일반 관제 선택기와 알림 textarea도 기본 규격을 쓰며 시나리오 도구의 서체 override는 공유 폰트를 사용한다.
- 자원 표 34px/4px 선택기, 조밀한 업무 목록·utility, 모바일 카드·sheet·날짜 popover와 레거시 참조의 별도 배치는 유지했다. 기사 컨트롤러의 상태·명령을 대량 분해하지 않았다.

검증:

- `make check-new-stack`: Kotlin 컴파일·detekt·health 테스트·JAR, TypeScript·Oxlint·Vite 빌드, 프런트 257개·산출물 3개·출처/기존 writer 연결 39개 통과.
- 루트 `npm test`: 491개 통과. lint 오류 0개, 기존 Anti Slop 경고 2개는 남아 있다.
- 인벤토리 schema 2: 원본 142개·최초 대상 145개 이력, 현재 파생 163건·별도 authored 17개. 원본/현재 SHA, CSS 구간·순서, 지도와 툴바 exact 추출, pure 테스트 34개·bridge 5개 및 Node 공유 모델 보호 검사 유지.
- 실제 브라우저: 가이드는 CSS 화면 너비 1440·390·320px, 배차는 1440·390·320px, 자원은 390·320px, 관제는 320px, 기사는 1440·390px에서 페이지 가로 넘침 없음으로 측정했다. 고객 390px 등 추가 화면 이미지도 검토했다. 가이드 320px 헤더 135→56px, 입력 40→44px, 버튼 36→44px, 기본 반경 3→6px. 가이드 탭 44px 확인. 브라우저 배율과 무관하게 기록의 `width`는 실제 `innerWidth`다.
- 포인터 메뉴는 링크 focus, keyboard/수정 키 이후 keyboard/history는 제목 focus, 달력 Escape는 trigger focus로 복원. 가이드 floating 패널 가림 없음. 인증 스크립트를 차단한 실제 native 등록 POST 400에서도 폰트·44px 입력·56px 헤더·6px 반경 확인. 차단 설정은 복원했다.
- 격리 합성 자료: 배차 계산→확정→기사 배송 시작(확인 포함)→관제 현재 배송지/ETA 반영→고객 배송 중·5박스·원본 주문 2건을 확인했다. 자원 편집·취소 확인·원복과 과거 관제 읽기 전용도 확인했다.

이미지·치수·최초 CSS/지도 추출 증거는 `apps/web/.runtime/design-proof/`, native 시각 판정은 `.omx/state/frontend-design-cleanup/ralph-progress.json`에 보존한다. 두 경로는 검증 생성물이며 fresh checkout의 테스트 의존성이 아니다. 변경 위치와 책임은 `apps/web/README.md`, 제품 계약은 `DESIGN.md`에 둔다.

로컬 프런트 개선과 검증을 완료했다. 원본 UI·기존 서버·실자료·배포는 변경하지 않았다. 테스트 서버 배포와 Kotlin 업무 API 이행은 별도 범위다.
