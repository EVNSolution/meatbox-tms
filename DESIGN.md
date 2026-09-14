# Design

## Source of truth
- Status: Active. User approved 목록·관리·관제 on 2026-09-14.
- Last refreshed: 2026-09-14.
- Primary surfaces: combined operator workspace and mobile customer viewer.
- Evidence: `../design.md`, `workspaces/jiin-ui/index.html`, its CSS, the current combined viewer, and the user's navigation and floating-guide corrections.
- This contract governs the combined demo. Owner snapshots remain unchanged.

## Brand
- Restrained operations UI, readable tables, clear selection. Magenta identifies the brand and floating presentation controls.
- Avoid decorative dashboards, fabricated device data, and developer command names in normal workflows.

## Product goals
- Make operational jobs distinct while keeping one shared scenario and selected delivery.
- Make presentation stages, time, changes and next action explainable in the guide.
- Non-goals: actual maps in operations, production integrations, changing the simulation's ETA policy.
- Success: operators can find lookup, route editing and monitoring without unrelated panels.

## Personas and jobs
- Presenter: progress and explain the scenario using a movable guide.
- Operator: find deliveries, edit remaining order, inspect events and monitor ETA.
- Customer reviewer: inspect the preserved mobile screen and its right-hand timeline.

## Information architecture
- Header: brand → 배송 시연 → 운영 뷰어 / 고객 뷰어 → 시연 안내.
- Operator left menu: 배송 목록 / 배송 관리 / 배송 관제.
- 목록: existing table, filters and selection summary. Equal control heights.
- 관리: full route, explicit edit mode, row handles, save/cancel; selected delivery events and notification copy.
- 관제: large map placeholder, selected delivery ETA and delivery timeline. No route controls or duplicate vehicle cards.
- Customer: no operator sidebar; preserve desktop phone viewer and right timeline, responsive mobile body.
- Legacy control route opens monitoring; legacy customer summary goes to the customer viewer.

## Design principles
- Navigation reflects a job, not a rendering implementation or ownership branch.
- Put presentation context and recent before/after changes in the guide, not a duplicate page card.
- Collapsed guide is a compact launcher; expanded guide stays wide and movable.
- Route editing uses a local draft. Save once; cancel changes nothing. Protect current/completed stops and reject stale saves.

## Visual language
- Reuse `apps/combined/styles.css` tokens and the original UI's typography, panels, table density and left navigation.
- White surfaces, gray workspace, 3px radii and restrained borders. Standard controls are 40px high (44px touch layouts).
- Large operations map remains a 720px reference height in document flow, with only 지도 미리보기 copy.

## Components
- Reuse existing ETA, timeline, event, notification and list renderers.
- Shared shell owns header viewer switching and floating guide.
- A route editor owns temporary order, handle interactions and save/cancel; backend validates a full update before applying it.

## Accessibility
- Use links for page navigation, buttons for actions, labeled selects and real headings.
- Route handles support keyboard arrows, plus visible movement buttons in edit mode.
- Preserve focus during live updates. Distinguish saved, stale, disconnected and disabled states in text.
- Preserve reduced-motion styles and avoid communicating state by color alone.

## Responsive behavior
- Header wraps deliberately; operator navigation becomes a compact horizontal menu on narrow screens.
- Customer phone remains 390×780 on desktop; small screens use the responsive customer page.
- Guide stays within the viewport; long content scrolls inside it. Collapsed launcher occupies only a small footprint.

## Interaction states
- Existing connection notices cover loading and offline state.
- Empty filter results do not hide unrelated management/monitoring deliveries.
- Pending saves disable resubmission. Stale route edits require fresh data, never silent overwrite.
- Errors remain visible with a recovery action. No actual notification delivery is implied.

## Content voice
- Use concise Korean task labels and specific status/time text.
- Distinguish published ETA, calculated ETA, arrival and completion.
- Keep introductions short and natural; prefer 차량 1대 · 배송지 8곳 over 차량 1대의 배송 8곳. Original links are 상현 시나리오 원본 and 클라인 UI 원본.

## Implementation constraints
- Vanilla HTML/CSS/JS; no new dependency.
- Preserve both original workspace snapshots and the simulation algorithms.
- Plan: restructure shell and page composition, move review context into guide, add guarded draft route editing, then validate navigation/filters/save/cancel/first completion and responsive visuals.
- Regression evidence: original snapshot checks and existing simulation tests, targeted route-update tests, browser interactions and screenshots.

## Open questions
- None blocking this approved three-menu structure. A real map/data integration remains outside this demo change.
