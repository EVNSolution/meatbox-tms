# 프런트·Kotlin API 연결 첫 단계

2026-10-05, Asia/Seoul. 새 `apps/web/` 프런트가 현재 상대 URL 계약을 유지하면서 실제 Kotlin 조회 API를 사용하도록 연결한다. 기존 미커밋 포크·디자인 개선을 보존한다.

## 이번 구현 단위

- Kotlin 소유: `GET/HEAD /api/dispatch-data/manifest`, `/api/dispatch-data/days/:date`, `/api/dispatch-data/regions`. 가져온 원본 bundle의 manifest 검증·날짜 allowlist·파일 조회를 구현한다. Node HTTP 응답을 재전달하는 facade가 아니라 설정한 원본 파일을 Kotlin이 직접 읽는다. 이 파일 입력은 이행용 어댑터이며 최종 DB나 실제 미트박스 공급자 계약을 확정하지 않는다.
- Node 소유: 계정·세션·초대·로그인/로그아웃, 누적 배송지 검색, 자원 SQLite, 날짜별 상태/계산/확정/운행 명령과 checkpoint, 참조 시뮬레이션 HTTP/WebSocket. Kotlin은 이 저장소에 쓰지 않는다.
- 게이트웨이: 명시한 Kotlin origin이 있을 때만 위 세 조회 경로의 GET/HEAD를 Kotlin으로 연결한다. `/days/:date/state`와 `/commands` 및 다른 method/path는 Node에 유지한다. 선택한 Kotlin이 중단되면 503으로 실패하며 Node로 자동 대체하지 않는다. 현재 legacy 전용 실행은 그대로 사용할 수 있다.
- 프런트 실패 경계: Kotlin 조회 응답에는 오류까지 `X-Meatbox-Source-Reader: kotlin`을 붙인다. manifest 404라도 명시적 reader가 있으면 시뮬레이션으로 전환하지 않는다. 현재 Node 전용 모드의 reader 헤더 없는 404만 기존 참조 시뮬레이션을 선택한다. strict TypeScript 계약 함수와 실제 연결 분기의 회귀로 두 동작을 검증한다.
- 인증: Kotlin 조회 API 자체도 현재 Node `/api/session`에 요청 Cookie를 전달해 확인한다. 정상 401은 `LOGIN_REQUIRED`; 연결·timeout·redirect·잘못된 JSON/사용자 응답은 503이다. 로그인 권한을 헤더·브라우저 주장으로 대체하거나 기존 계정 파일을 Kotlin에 복제하지 않는다.
- 설정: 명시적 compat 활성화, 정확한 loopback Node origin과 절대 원본 디렉터리를 요구한다. health만 실행하는 기존 기본 모드는 유지한다. Kotlin compat는 로컬 이행용이며 원격 배포·계정/DB/실자료 이행을 수행하지 않는다.

## 계약과 완료 조건

- JSON 의미, calendar-valid 날짜, 없는 입력 404 `DISPATCH_DATA_UNAVAILABLE`, 없는 일자/파일 404 `DISPATCH_DATA_NOT_FOUND`, 손상 manifest 500 `DISPATCH_DATA_INVALID`를 보존한다. 파일 경로·비밀값은 오류에 넣지 않는다. gzip·HEAD·conditional GET는 HTTP 의미를 검증한다.
- Kotlin은 인증 전에 자료를 노출하지 않는다. 세션 만료/로그아웃, auth 서버 중단·malformed/oversized 응답, 직접 API 접근, 임의 파일 경로와 심볼릭 링크 경계를 테스트한다.
- 같은 합성 원본과 세션으로 Node/Kotlin 세 조회 응답을 비교한다. 배차 상태/명령·자원·WebSocket은 선택적 라우팅에도 Node로만 전달되며 CAS·Origin 의미를 유지한다.
- `make run-connected-fixture`가 프런트·Kotlin·기존 writer를 함께 기동한다. 계정/JSON/SQLite/checkpoint는 시스템 임시 디렉터리에 격리하고 종료 때 JVM·Node·gateway와 임시 자료를 정리한다. 연결 계약 테스트는 JVM 산출물을 먼저 만드는 별도 명령으로 제공한다.
- Kotlin 테스트·detekt·JAR, 웹 타입/lint/build/tests, 포크 provenance와 기존 writer 회귀, 실제 로그인/조회/명령 브라우저 검증을 완료한다. 디버그 구현 정보는 제품 화면에 추가하지 않는다.

## 검토와 후속 경계

작성과 독립 검토를 분리한다. 실제 코드에서 계약별 상태·응답·라우팅을 검토하고 통합 검증 결과를 이 문서에 추가한다. 이번 세 API 연결 완료와 Kotlin 전체 업무/인증 이관을 구분한다. 다음 이관 단위는 인증·권한·저장 계약을 정한 뒤 자원 또는 날짜 집계의 단일 writer를 통째로 바꾸는 작업이다.

Node 세션 검증 client는 HTTP/1.1로 고정한다. Java 21 기본 HTTP/2 client는 cleartext origin에서 h2c `Upgrade`를 시도하며, 기존 Node의 WebSocket-only upgrade handler는 이를 401로 거부한다. 실제 Node+JAR 통합에서 이 문제를 재현하고 plain GET/Cookie/Upgrade 부재 회귀와 실제 세션 조회로 검증한다. 근거: [Java 21 HttpClient](https://docs.oracle.com/en/java/javase/21/docs/api/java.net.http/java/net/http/HttpClient.html), [OpenJDK h2c 헤더 구현](https://github.com/openjdk/jdk21u/blob/bb6b279495ceff8442dbd0225756b92d466d5309/src/java.net.http/share/classes/jdk/internal/net/http/HttpRequestImpl.java#L278-L282), [Node upgrade 이벤트](https://nodejs.org/api/http.html#event-upgrade).

## 적용 결과와 검증

세 조회 API의 Kotlin 파일 reader, Node 세션 검증, gateway/Vite의 선택적 라우팅, 프런트의 명시적 reader 오류 경계, 합성 connected fixture와 실제 JAR 통합 검증을 구현했다. 인증과 모든 업무 쓰기는 기존 Node가 소유한다. `make run-connected-fixture`로 같은 구성을 다시 실행할 수 있다. 실제 연결 검증은 `make check-api-connection`에 묶었다.

2026-10-05 로컬 검증 결과:

- `make check-new-stack` 통과: Kotlin 테스트 20개·detekt·bootJar, 웹 strict TypeScript·lint·11개 HTML 빌드, 웹 테스트 270개, 산출물 검사 3개, provenance 및 기존 writer 연결 회귀 39개. 기존 lint 경고 2건은 유지된다.
- 기존 루트 `npm test` 491개 통과. 원본 회귀의 기대값이나 기존 업무 모델을 연결 구현에 맞춰 변경하지 않았다.
- 빌드한 JAR와 Node 및 gateway를 함께 기동한 연결 테스트 10개 통과. 세 JSON 계약, 인증/로그아웃, gzip/HEAD/ETag, 잘못된 입력, Node Origin/CAS/계산/확정, Kotlin 중단 시 503과 Node 업무/WS 지속, 종료 후 임시 자료·포트 정리를 검증했다.
- 인증된 합성 브라우저에서 세 조회 응답의 `X-Meatbox-Source-Reader: kotlin`과 200 상태를 확인했다. 주문 3건·배송지 2곳·9박스를 계산하고 확정한 뒤, 기사 배송 시작이 관제의 현재 배송지/처리 이력과 고객 화면의 배송 중/5박스/주문 2건에 반영됨을 확인했다.
- 독립 계획·구현 검토 결과 APPROVE/CLEAR. 작성자가 구현하고 별도 검토자가 인증·라우팅·오류 계약을 검토했으며, 실제 JAR 및 브라우저 검증은 root에서 수행했다.

브라우저 캡처와 선별한 응답 메타데이터는 `apps/web/.runtime/api-connection-proof/`에 보관한다. 이 경로는 생성 산출물이며 커밋 대상이 아니다. 장시간 폴링으로 후반 네트워크 이벤트 일부가 버퍼에서 제거됐으므로, 계산/확정/배송 시작의 HTTP 계약 근거는 실제 JAR 통합 테스트이고 화면 반영 근거는 캡처다. Cookie와 응답 본문은 증거 JSON에 저장하지 않는다.

이번 결과는 격리한 로컬 합성 자료의 연결 검증이다. 운영/QA/TEST 서버 배포, 실제 공급자 데이터, Kotlin 인증·권한 및 쓰기 저장소 이관, 실시간 GPS·고객별 공개 권한·실제 알림 전달은 별도 작업이다. 현재 reader는 원본 파일 전체를 메모리에 읽고 해시하므로 실제 파일 크기와 동시 요청에 따른 메모리 상한은 서버 적용 전에 검증해야 한다.
