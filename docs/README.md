# 문서 안내

미트박스 TMS를 이해하고, 개발하고, 운영하고, 인수인계하기 위한 문서 모음입니다. 사용법과 계약은 관련 구현이 바뀔 때 함께 갱신하고, 배포별 결과는 별도 기록에 남깁니다.

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
| [api-reference.md](api-reference.md) | 서버가 제공하는 API와 요청·응답 계약은 무엇인가? |
| [dated-dispatch-data.md](dated-dispatch-data.md) | 어떤 원본에서 어떤 산출물을 만드는가? |
| [operator-guide.md](operator-guide.md) | 화면에서 어떤 순서로 업무를 수행하고 결과를 확인하는가? |
| [development.md](development.md) | 로컬 격리 환경을 어떻게 준비하는가? |
| [verification.md](verification.md) | 어떤 검증이 어떤 주장을 뒷받침하는가? |
| [operations.md](operations.md) | 설정·배포·백업·복구·장애를 어떻게 다루는가? |
| [security-and-access.md](security-and-access.md) | 현재 인증과 데이터 접근의 한계는 어디인가? |
| [production-readiness.md](production-readiness.md) | 실제 운영 확대 전에 무엇을 입증해야 하는가? |
| [documentation-policy.md](documentation-policy.md) | 앞으로 문서가 다시 낡지 않게 하려면 무엇을 갱신하는가? |

## 기록과 문서 관리

- [릴리스 기록 양식](templates/release-record.md): 적용 버전, 환경, 검증 결과, 복구 근거를 배포별로 기록합니다.
- [장애 기록 양식](templates/incident-record.md): 영향 범위, 관측 사실, 조치와 복구 결과를 기록합니다.
- [설계·검증 이력](history/README.md): 과거 결정과 시험·배포 결과를 찾습니다.
- [문서 관리 기준](documentation-policy.md): 기능 변경에 따른 갱신 범위와 기록 원칙을 확인합니다.
