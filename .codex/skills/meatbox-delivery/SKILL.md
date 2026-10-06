---
name: meatbox-delivery
description: Commit, review, validate and deploy authorized Meatbox changes using purpose-based commits, one CI pipeline and reusable verified artifacts. Use for project PR, GitHub Actions or deployment work.
---

# 미트박스 변경 전달

이 프로젝트의 커밋·PR·CI·배포에서는 [작업 기준](../../../docs/delivery-workflow.md)을 읽고 적용한다. 사용자는 요청받은 작업의 배포를 상시 허용했다. 현재 설정된 TEST 대상에서 검증·배포·인증된 화면 확인까지 이어서 수행하며 같은 배포 허용을 다시 묻지 않는다. 구체적인 접근·대상 장애가 있을 때만 보고한다. 업무 자료 삭제나 다른 환경·프로젝트로 범위를 확대하지 않는다.

- 작업 트리와 현재 PR·Actions 실행을 먼저 확인한다. 기존 수정은 보존하고 목적별 커밋을 만든다. `Feat:`, `Fix:`, `Refactor:`, `CI:`, `Docs:` 등 실제 변경에 맞는 접두사를 쓰며 `Codex` 접두사는 금지한다. Lore decision trailer는 유지한다.
- PR 상태 검사는 Actions 결과다. 같은 SHA의 기존 실행을 재사용하며 기능 브랜치 push와 PR 이벤트로 중복 검사를 만들지 않는다. 검증된 커밋 묶음을 한 번 push하고 superseded PR 실행만 취소한다.
- 같은 테스트 파일·설치·빌드를 파이프라인 안에서 두 번 실행하지 않는다. 서로 다른 PR merge ref와 기본 브랜치 후보의 검증을 혼동하지 않는다. 검증의 범위를 줄여 시간을 맞추지 않는다.
- `make package-new-stack`으로 검사·빌드한 immutable archive를 생성하거나, 동일 후보의 성공한 CI artifact를 사용한다. 배포 단계에서 같은 소스를 다시 설치·검사·빌드하지 않는다. run·Git SHA·릴리스 ID·archive SHA와 manifest를 연결해 검증한다.
- [TEST 배포·복구 절차](../../../deploy/new-stack/README.md)를 따른다. 환경별 직렬화, 활성 mode:releaseId 비교, 백업·복구, 자료 보존과 단일 writer를 유지한다. 전환 중인 배포는 새 PR 때문에 강제 취소하지 않는다.
- 실제 단계별 시간을 기록하고 CI·artifact·서버 실행·인증 화면의 결과를 각각 보고한다. 임시 접근 자료를 정리하고, 검증이나 배포가 실패하면 원인을 수정해 같은 완료 범위까지 이어간다.
