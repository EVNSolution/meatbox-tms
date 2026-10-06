# 미트박스 TMS

미트박스의 주문 배차와 배송 현황을 관리하는 웹 애플리케이션입니다. 운영자는 날짜별 배차를 계산·확정하고 차량과 지역 코드를 관리합니다. 현행 프런트는 운영 화면 3개와 로그인·등록·디자인 가이드로 구성됩니다.

## 주요 기능

- **배차 관리**: 날짜별 주문 조회, 배차 계산, 핀배차, 배차 확정
- **배송 관제**: 확정 배차와 배송 현황 조회, 배송 순서 및 기록 관리
- **자원 관리**: 차량 조회, 지역 코드 등록·변경, 차량별 코드 지정

## 개발 환경

현행 제품은 `apps/web`의 TypeScript·Vite 단일 프런트와 `services/api`의 Kotlin·Spring Boot API로 구성됩니다. Node.js **22.18 이상**은 프런트 빌드, 게이트웨이와 레거시 계약 회귀 검증에 필요합니다.

```sh
git clone https://github.com/EVNSolution/meatbox-tms.git
cd meatbox-tms
make setup-new-stack
make check-release
```

새 스택의 설치·실행·검사는 [개발 환경](docs/new-stack-development.md)에 정리되어 있습니다. 기존 Node 호환 API 회귀는 [레거시 개발 환경](docs/development.md)을 따릅니다. 원본 주문 자료는 저장소에 포함되어 있지 않습니다.

## 디렉터리 구조

| 경로 | 설명 |
|---|---|
| [apps/web/](apps/web/) | 모든 현행 웹 화면, 브라우저 모듈과 정적 자산 |
| [services/api/](services/api/) | Kotlin·Spring Boot 인증, 자원, 배차·운행 API |
| [server.js](server.js), [lib/](lib/) | 레거시 API 호환·rollback 검증과 Node 골든 엔진 |
| [apps/combined/](apps/combined/) | Node 골든 엔진이 공유하는 순수 모델과 상태 프레임 |
| [apps/portal/](apps/portal/) | 레거시 인증 호환용 화면 생성과 공용 자산 |
| [scripts/](scripts/) | 데이터 준비, 계정 관리, 자원 DB 생성, 검증 스크립트 |
| [test/](test/), `apps/combined/*.test.mjs` | API, 상태, 이행 호환성 테스트 |
| [deploy/](deploy/) | Caddy·systemd 설정 파일 |
| [workspaces/sanghyun-scenario/src/](workspaces/sanghyun-scenario/src/) | 보존된 시뮬레이션·ETA 골든 계산 코드 |
| [docs/](docs/) | 개발·운영 문서 |

## 데이터 처리

- 배차 계산 결과는 초안입니다. 화면에서 **전체 배차 전송**을 실행하면 서버에 확정 배차로 저장됩니다. 이후 수정안을 편집해도 기존 확정 배차는 유지됩니다.
- 업무 날짜는 서울 시간(`Asia/Seoul`)을 기준으로 합니다. 과거 날짜는 조회만 가능하며, 자료가 없는 날짜에는 주문과 배차 내역이 표시되지 않습니다.
- native API는 `MEATBOX_DISPATCH_STATE_DIR`의 명시적 절대 경로에 날짜별 배차 상태를 저장합니다. writer를 활성화하면서 저장 경로를 생략하면 시작을 거부합니다. 기존 Node 호환 모드의 경로 설정은 `DISPATCH_STATE_DIR`입니다.
- 차량과 지역 코드는 일별 배차와 별도의 SQLite DB에서 관리합니다. 하나의 지역 코드를 여러 차량에 지정할 수 있습니다.

## 구현 범위

과거 고객·기사·시나리오 UI는 실제 삭제했고 해당 gateway URL은 모든 모드에서 410을 반환합니다. [삭제 결과와 검증](docs/demo-removal-result.md)을 확인하세요. 역할·고객·차량별 접근 제어, 배송 사진의 영구 저장, 실제 GPS 수신은 아직 구현되지 않았습니다. 미트박스 주문 API 및 외부 배송원 앱과의 연동도 별도 개발이 필요합니다. 화면의 **배차 전송**은 서버에서 배차를 확정하는 기능이며, 외부 배송원 앱의 알림 수신까지 처리하지는 않습니다. 위치와 ETA에는 시연·계획 데이터가 포함될 수 있습니다.

세부 구현 현황과 남은 작업은 [운영 전환 기준](docs/production-readiness.md)에 정리되어 있습니다.

## 관련 문서

- [이관 Git 기준점과 독립 검토](docs/release-baseline-2026-10-05.md)

- [현행 구조](docs/new-stack-architecture.md) · [기능별 파일 책임](docs/project-structure.md) · [이번 이관 결과](docs/kotlin-state-migration-result.md)
- [기존 Node 계약 문서](docs/architecture.md) · [배차 데이터와 상태](docs/domain-and-state.md) · [API 명세](docs/api-reference.md)
- [개발 환경](docs/development.md) · [테스트 및 검증](docs/verification.md)
- [운영 절차](docs/operations.md) · [보안 및 접근 제어](docs/security-and-access.md)
- [업무 가이드](docs/operator-guide.md) · [UI 설계](DESIGN.md)
- [전체 문서 목록](docs/README.md)
