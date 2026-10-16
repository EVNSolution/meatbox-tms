# 문서

## 현재 이관 기준

현행 제품 구조와 실행 기준은 아래 문서를 먼저 읽는다. 나머지 Node API·배포·화면 문서는 기존 계약과 이행 이력의 참고 자료이며 폐기한 고객·기사·시나리오 UI를 현행 제품으로 해석하지 않는다.

- [마스터 계획서 (범위·결정·상태 정본)](master-plan.md), [앱·미트박스 연동 계약 초안](integration-contract.md)
- [이관 Git 기준점과 독립 검토](release-baseline-2026-10-05.md)
- [단일 프런트·Kotlin 구조](new-stack-architecture.md), [기능별 파일 책임](project-structure.md)
- [새 스택 설치·실행·검사](new-stack-development.md), [현재 UI 기준](../DESIGN.md)
- [기존 UI·기능 이관 완료 범위](ui-migration-completion.md), [다음 기능의 커밋·PR 계획](next-feature-delivery-plan.md)
- [Kotlin 이관 검증](kotlin-state-migration-result.md), [데모 실제 삭제 결과](demo-removal-result.md)
- [삭제 파일 전체 목록](demo-removal-inventory.json), [중간 정리와 다음 작업](migration-checkpoint-2026-10-05.md)

## 기존 개발 및 운영 참고

| 문서 | 내용 |
|---|---|
| [개발 환경](development.md) | 로컬 설치, 계정 생성, 환경 변수, 서버 실행 |
| [아키텍처](architecture.md) | 서버·화면 구성, 데이터 흐름, 모듈별 기능 |
| [배차 데이터와 상태](domain-and-state.md) | 초안·확정 배차, 식별자, 상태 변경, revision |
| [API 명세](api-reference.md) | API 경로, 요청·응답 형식, 오류 처리 |
| [날짜별 원본 자료](dated-dispatch-data.md) | 원본 데이터 형식과 변환·적재 절차 |
| [UI 설계](../DESIGN.md) | 화면 구성, 조작 방식, 로딩·오류·빈 상태 처리 |
| [모바일 화면 운영 범위](mobile-surface-policy.md) | 운영 관제와 고객·배송원 검토 화면의 경계, 실제 사용자 화면 전환 조건 |
| [화면 계층·정렬 일치 계획](layout-consistency-plan-2026-09-29.md) | 전체 화면 점검의 규칙, 수정 순서, 배포 판단 기준 |
| [업무 가이드](operator-guide.md) | 배차·관제·자원 관리 화면 사용법 |
| [테스트 및 검증](verification.md) | 테스트 실행, API·화면 검증, 결과 기록 |
| [운영 절차](operations.md) | 서버 설정, 배포, 백업·복구, 장애 대응 |
| [보안 및 접근 제어](security-and-access.md) | 인증 방식, 데이터 접근 권한, 보안상 제약 |
| [운영 전환 기준](production-readiness.md) | 미완료 기능과 운영 확대 전 확인할 항목 |

## 양식 및 이력

- [릴리스 기록](templates/release-record.md): 배포 버전, 환경, 검증 결과, 복구 방법
- [장애 기록](templates/incident-record.md): 영향 범위, 원인, 조치, 복구 결과
- [설계·검증 이력](history/README.md): 이전 설계 결정과 시험·배포 기록
- [문서 관리 기준](documentation-policy.md): 문서별 갱신 시점과 작성 원칙
