---
name: meatbox-work-unit
description: Define, execute, or review one Meatbox frontend fork or Kotlin API change with explicit scope and observable verification. Use for product implementation and tooling changes in this repository.
---

# 미트박스 작업 단위

Karpathy의 네 원칙을 이 프로젝트의 확정된 방향에 적용합니다. 사용자 요청과 기존 실행·검증 규칙을 따르며, 별도 최상위 오케스트레이터를 시작하지 않습니다.

- [확정 아키텍처](../../../docs/new-stack-architecture.md)를 한 번 읽습니다. 기존 UI 전체를 `apps/web/` 단일 프런트로 포크하고 서버는 `services/api/`의 Kotlin·Spring Boot로 구현합니다. 사용자 변경 지시 없이 언어·모듈·UI 재작성 선택을 다시 열지 않습니다.
- 편집 전에 [한 번의 구현 단위](../../../docs/agent-tooling-setup.md)의 요구 동작·범위와 상태 소유자·가정·완료 조건·검증을 짧게 정합니다. 확인할 수 있는 사실은 직접 확인하고, 명확한 로컬 작업은 계속 진행합니다. 결과나 데이터 소유권을 실질적으로 바꾸는 미확정 계약만 질문합니다.
- 기존 UI·표준 기능을 우선하고 변경을 해당 요구에 연결합니다. 사용자가 요청한 완전한 포크의 화면·동작을 단순화 명목으로 누락하지 않습니다. 포크는 파일 복사뿐 아니라 기존 서버의 화면 생성·주입과 브라우저 의존성까지 대조합니다.
- 브라우저에는 서버 구현·비밀값·데이터 쓰기 소유권을 옮기지 않습니다. 데모나 CSV로 실제 제공자 계약을 추정하지 않습니다. 기존 코드와 자료는 근거이며 운영 동작의 증거는 별도로 확인합니다.
- 해당 변경을 입증할 최소 검사를 실행하고 결과를 읽습니다. 실패하면 수정·재검증하고, 확인할 수 없는 항목은 남은 경계로 보고합니다. 설정·컴파일·lint 통과와 실제 UI·업무·배포 성공을 구분합니다.
- OMX는 조정·완료 판정, Ponytail은 구현 최소화, Attention-kind는 주 대화의 표현을 담당합니다. 이 스킬 때문에 추가 승인 단계나 전역 규칙을 만들지 않습니다.
- 커밋·PR·CI·배포는 [미트박스 변경 전달 스킬](../meatbox-delivery/SKILL.md)과 [작업 기준](../../../docs/delivery-workflow.md)을 따릅니다. 요청받은 작업의 배포는 상시 허용되어 있으며, 목적별 커밋·한 번의 CI·검증된 artifact 재사용을 적용합니다.

원칙 출처: [andrej-karpathy-skills의 CLAUDE.md](https://github.com/multica-ai/andrej-karpathy-skills/blob/2c606141936f1eeef17fa3043a72095b4765b9c2/CLAUDE.md). 원문의 생각 먼저·단순성·필요한 변경·검증 가능한 목표를 프로젝트에 맞춰 한국어로 재작성했습니다. 원문을 중복 실행 지시문으로 설치하지 않습니다.
