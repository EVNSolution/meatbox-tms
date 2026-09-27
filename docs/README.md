# 문서 안내

미트박스 TMS를 이해하고, 개발하고, 운영하고, 인수인계하기 위한 문서 모음입니다. 현행 문서는 구현 커밋 `40387756a5c02d02af6ac134d4a2d5bfa1146bef`를 기준으로 2026-09-28에 정비했습니다. 서버의 현재 상태는 이 문서만으로 확정하지 않습니다.

## 필요한 곳부터 읽기

| 상황 | 읽는 순서 | 얻을 수 있는 결과 |
|---|---|---|
| 처음 합류한 담당자 | [프로젝트 소개](../README.md) → [아키텍처](architecture.md) → [도메인과 상태](domain-and-state.md) | 무엇이 어디에 저장되고 누가 변경하는지 이해 |
| 운영 화면을 사용하는 담당자 | [업무 가이드](operator-guide.md) → [상태·용어](domain-and-state.md) | 계산·확정·수정안·완료를 혼동하지 않고 처리 |
| 개발자 | [로컬 시작](development.md) → [API](api-reference.md) → [검증](verification.md) | 운영 데이터 없이 실행하고 변경 범위에 맞게 검증 |
| 장애 대응 담당자 | [운영 절차](operations.md) → [보안과 접근](security-and-access.md) | 상태 보존을 우선하는 진단·복구 판단 |
| 릴리스 담당자 | [검증](verification.md) → [운영 절차](operations.md) → [릴리스 기록 양식](templates/release-record.md) | 코드·설정·데이터·실행 결과를 분리한 인수인계 |
| 실서비스 전환을 결정하는 담당자 | [운영 전환 기준](production-readiness.md) → [보안과 접근](security-and-access.md) | 미완료 영역과 전환 허용 근거를 확인 |
| 화면을 수정하는 담당자 | [DESIGN.md](../DESIGN.md) → [업무 가이드](operator-guide.md) | 현재 화면 계약과 비어 있음·오류·충돌 처리 유지 |
| 자료를 준비하는 담당자 | [날짜별 원본 자료](dated-dispatch-data.md) → [운영 절차](operations.md) | 원본·파생 자료·배차 상태의 보존 경계 확인 |

## 현행 문서의 역할

| 문서 | 이 문서가 답하는 질문 |
|---|---|
| [architecture.md](architecture.md) | 구성요소가 어떻게 연결되는가? |
| [domain-and-state.md](domain-and-state.md) | 상태·식별자·revision의 의미와 변경 경계는 무엇인가? |
| [api-reference.md](api-reference.md) | 이 커밋이 실제로 제공하는 API는 무엇인가? |
| [dated-dispatch-data.md](dated-dispatch-data.md) | 어떤 원본에서 어떤 산출물을 만드는가? |
| [operator-guide.md](operator-guide.md) | 화면에서 어떤 순서로 업무를 수행하고 결과를 확인하는가? |
| [development.md](development.md) | 로컬 격리 환경을 어떻게 준비하는가? |
| [verification.md](verification.md) | 어떤 검증이 어떤 주장을 뒷받침하는가? |
| [operations.md](operations.md) | 설정·배포·백업·복구·장애를 어떻게 다루는가? |
| [security-and-access.md](security-and-access.md) | 현재 인증과 데이터 접근의 한계는 어디인가? |
| [production-readiness.md](production-readiness.md) | 실제 운영 확대 전에 무엇을 입증해야 하는가? |
| [documentation-policy.md](documentation-policy.md) | 앞으로 문서가 다시 낡지 않게 하려면 무엇을 갱신하는가? |

## 이력 자료

아래 문서는 **작성 당시의 결정·시험·배포 기록**입니다. 본문의 ‘현재’, ‘완료’, 수량과 SHA는 당시 범위에서 읽어야 합니다. 최신 동작과 충돌하면 위 현행 참조 문서와 실제 코드를 확인합니다. 원문 위치는 기존 링크를 보존하기 위해 유지했습니다.

| 주제 | 보존한 근거 |
|---|---|
| 이전 디자인·날짜 자료 계약 | [디자인 결정 원문](history/design-decisions-2026-09-28.md), [날짜 자료 초기 기록](history/dated-dispatch-data-2026-09-16.md) |
| 차량 중심 화면 전환 | [개편 계획](vehicle-operations-redesign-plan.md), [실행 요청](vehicle-operations-redesign-prompt.md) |
| 다차량 시연 | [설계](fleet-operations-plan.md), [당시 테스트 명세](fleet-operations-test-spec.md), [성능 측정](server-data-readiness.md) |
| 수동 장면 시연 | [설계](manual-scenarios-plan.md), [당시 테스트 명세](manual-scenarios-test-spec.md) |
| 2026-09-16 통합·배포 | [시스템 점검](system-integration-audit-2026-09-16.md), [배포 기록](deployment-2026-09-16-integration.md) |
| 발표·뷰어 인계 | [발표 준비](dispatch-presentation-2026-09-16.md), [발표 점검](presentation-scenario-audit-2026-09-16.md), [뷰어 인계](customer-driver-viewer-handoff.md) |
| 최근 화면·자원 변경 | [헤더·날짜 정리](header-date-cleanup-plan.md), [지역 코드 전환](resource-classification-cleanup-plan.md) |
| 검토용 프로필 | [미배정 후보](driver-profile-candidates.md) — 실제 직원 프로필이나 신원 검증 결과가 아님 |

[문서 정비 검증 기록](evidence/documentation-audit-2026-09-28.md)은 이번에 확인한 범위와 수정한 모순을 기록합니다. 이후 릴리스는 [릴리스 기록 양식](templates/release-record.md), 장애는 [장애 기록 양식](templates/incident-record.md)을 사용해 별도 시점 증거를 남깁니다.
