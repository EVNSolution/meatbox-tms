# 미트박스 TMS

미트박스의 주문 배차와 배송 현황을 관리하는 웹 애플리케이션입니다. 운영자는 날짜별 배차를 계산·확정하고 차량과 지역 코드를 관리합니다. 배송원과 고객은 각 화면에서 배차와 배송 상태를 확인합니다.

## 주요 기능

- **배차 관리**: 날짜별 주문 조회, 배차 계산, 핀배차, 배차 확정
- **배송 관제**: 확정 배차와 배송 현황 조회, 배송 순서 및 기록 관리
- **자원 관리**: 차량 조회, 지역 코드 등록·변경, 차량별 코드 지정
- **배송원 화면**: 배차 조회, 출발·도착·배송 완료 처리, 고객 요청 확인
- **고객 화면**: 주문 상태, 예상 도착 시간, 알림 조회

## 개발 환경

Node.js **22.13 이상**이 필요합니다. 서버는 Express와 WebSocket, 프런트엔드는 브라우저 ES 모듈로 구성되어 있습니다. 차량과 지역 코드는 Node 내장 SQLite에 저장합니다.

```sh
git clone https://github.com/EVNSolution/meatbox-tms.git
cd meatbox-tms
npm ci
npm test -- --test-concurrency=1
```

서버 실행에는 계정 파일과 `PUBLIC_ORIGIN` 설정이 필요합니다. 계정 생성, 환경 변수 설정, 실행 명령은 [개발 환경](docs/development.md)에 정리되어 있습니다. 원본 주문 자료는 저장소에 포함되어 있지 않습니다.

## 디렉터리 구조

| 경로 | 설명 |
|---|---|
| [server.js](server.js), [lib/](lib/) | 서버 진입점, 인증, API, 배차 상태 및 자원 DB 처리 |
| [apps/combined/](apps/combined/) | 운영·배송원·고객 화면 |
| [apps/portal/](apps/portal/) | 로그인·초대 가입 화면 |
| [scripts/](scripts/) | 데이터 준비, 계정 관리, 자원 DB 생성, 검증 스크립트 |
| [test/](test/), `apps/combined/*.test.mjs` | 서버 및 클라이언트 테스트 |
| [deploy/](deploy/) | Caddy·systemd 설정 파일 |
| [workspaces/](workspaces/) | 초기 UI와 시나리오 원본 |
| [docs/](docs/) | 개발·운영 문서 |

## 데이터 처리

- 배차 계산 결과는 초안입니다. 화면에서 **전체 배차 전송**을 실행하면 서버에 확정 배차로 저장됩니다. 이후 수정안을 편집해도 기존 확정 배차는 유지됩니다.
- 업무 날짜는 서울 시간(`Asia/Seoul`)을 기준으로 합니다. 과거 날짜는 조회만 가능하며, 자료가 없는 날짜에는 주문과 배차 내역이 표시되지 않습니다.
- `DISPATCH_STATE_DIR`을 설정하면 날짜별 배차 상태를 파일에 저장합니다. 설정하지 않으면 서버 재시작 시 상태가 사라집니다.
- 차량과 지역 코드는 일별 배차와 별도의 SQLite DB에서 관리합니다. 하나의 지역 코드를 여러 차량에 지정할 수 있습니다.

## 구현 범위

역할·고객·차량별 접근 제어, 배송 사진의 영구 저장, 실제 GPS 수신은 아직 구현되지 않았습니다. 미트박스 주문 API 및 외부 배송원 앱과의 연동도 별도 개발이 필요합니다. 화면의 **배차 전송**은 서버에서 배차를 확정하는 기능이며, 외부 배송원 앱의 알림 수신까지 처리하지는 않습니다. 위치와 ETA에는 시연·계획 데이터가 포함될 수 있습니다.

세부 구현 현황과 남은 작업은 [운영 전환 기준](docs/production-readiness.md)에 정리되어 있습니다.

## 관련 문서

- [아키텍처](docs/architecture.md) · [배차 데이터와 상태](docs/domain-and-state.md) · [API 명세](docs/api-reference.md)
- [개발 환경](docs/development.md) · [테스트 및 검증](docs/verification.md)
- [운영 절차](docs/operations.md) · [보안 및 접근 제어](docs/security-and-access.md)
- [업무 가이드](docs/operator-guide.md) · [UI 설계](DESIGN.md)
- [전체 문서 목록](docs/README.md)
