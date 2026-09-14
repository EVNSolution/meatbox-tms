# Design

## Source of truth
- Status: Active. User approved applying the local reference to the actual app and authorized deployment on 2026-09-14.
- Last refreshed: 2026-09-14.
- Primary surfaces: combined operator, customer and driver viewers.
- Evidence: `../design.md`, `../previews/terminal-view/` approved reference and official assets, the current combined viewer, and the user's navigation and floating-guide corrections.
- This contract governs the combined demo. Owner snapshots remain unchanged.

## Brand
- Restrained operations UI, readable tables, clear selection. Use the original Meatbox logo and app icon from the official reference assets. Logo/navigation red is #E60028; brand ink is #212322; search/presentation accent remains #DB0E64.
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
- Driver reviewer: check the current destination and record completion after arrival.

## Information architecture
- Header: official brand → 운영 뷰어 / 고객 뷰어 / 배송원 뷰어 → 시연 안내.
- Operator left menu: 주문 관리 / 배송 목록 / 배송 관제. Viewer switching preserves selected delivery, filters and last operator page; customer/driver viewers do not select an operator item.
- 목록: existing table, filters and selection summary. Equal control heights.
- 주문 관리: list only orders actually received in the shared simulation, with existing item/box/status data and a link to the same delivery. Do not invent production order identifiers or CRUD.
- 관리: full route, explicit edit mode, row handles, save/cancel in the 배송 관제 right-side 배송 관리 tab; preserve pending/current/completed/held and stale-save safeguards.
- 관제: selected delivery ETA, delivery timeline, events/customer notices and a right-side 배송지 목록 / 배송 관리 tab group. A map-free monitoring layout is the default; retain the existing map placeholder behind an explicit 지도 미리보기 disclosure. No actual map integration.
- Monitoring uses a right-hand delivery list with sequence, name, status and ETA. Selecting a row shows its summary, ETA and timeline in the main column; 배송지 목록 focuses the list in the right-hand panel. Explicit links retain their selected delivery; the navigation menu opens the list. 현재 배송지 보기 is available during delivery, and live progress never changes an explicit selection.
- Customer: shared three-axis header/rail, preserve desktop phone viewer and right timeline and responsive mobile body.
- Driver: same authenticated simulation, current destination and ordered stops; reuse existing completion behavior, available only after actual simulated arrival. Keep current/selected delivery distinct.
- Legacy #/manage routes redirect to #/control with the management tab selected.
- Legacy control route opens monitoring; legacy customer summary goes to the customer viewer.

## Design principles
- Navigation reflects a job, not a rendering implementation or ownership branch.
- Put presentation context and recent before/after changes in the guide, not a duplicate page card.
- Collapsed guide is a compact launcher; expanded guide stays wide and movable.
- Route editing uses a local draft. Save once; cancel changes nothing. Protect current/completed stops and reject stale saves.

## Visual language
- Reuse `apps/combined/styles.css` tokens and the original UI's typography, panels, table density and left navigation.
- White surfaces, gray workspace, role-based radii 4/6/8/12px. Standard controls are 40px high (44px touch layouts). Pretendard Variable is self-hosted: body400, menus/states500, sections/buttons600, titles/times700.
- No left inset shadow, left pseudo strip or thick left border on any element. Selected rows use surface/text/badge state. Business tabs are full-rail-width 48px centered rectangles, radius0; active text and a straight right 3px rule use #E60028. Viewer tabs use an absolute bottom 3px rule that does not affect height.
- Desktop header56px; at <=860px brand row44px + viewer row44px + border1px. Left rail92px/72px narrow. Content title begins24px below desktop header,20px narrow; no redundant operator eyebrow. Delivery metadata uses stacked rows, label64px + gap12px + flexible value, baseline aligned and padding12px 0.
- Large operations map remains a 720px reference height in document flow, with only 지도 미리보기 copy.

## Components
- Reuse existing ETA, timeline, event, notification and list renderers.
- Monitoring back navigation sits in the selected delivery title bar. Keep its metadata, ETA rows and timeline compact, with all timestamps visible and 44px mobile action targets.
- Shared shell owns header viewer switching and floating guide.
- A route editor owns temporary order, handle interactions and save/cancel; backend validates a full update before applying it.

## Accessibility
- Use links for page navigation, buttons for actions, labeled selects and real headings.
- Route handles support keyboard arrows, plus visible movement buttons in edit mode.
- Preserve focus during live updates. Distinguish saved, stale, disconnected and disabled states in text.
- Preserve reduced-motion styles and avoid communicating state by color alone.

## Responsive behavior
- Header wraps deliberately into two rows at <=860px; the operator rail stays vertical and narrows to72px. At <=520px viewer tabs divide the available row equally.
- Customer phone remains 390×780 on desktop; small screens use the responsive customer page.
- Guide stays within the viewport; long content scrolls inside it. Collapsed launcher occupies only a small footprint.
- On narrow monitoring screens, stack the list/management panel, selected delivery details, timeline, events and collapsed map preview. ETA cells use equal padding and one divider between the two rows.

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
- Approved rollout: apply approved assets/tokens and three-axis shell, add simulation-backed order/driver viewers, absorb existing management into control, then validate navigation/filter/selection restoration, save/cancel, first completion and responsive visuals. Use the existing authenticated release process; preserve production accounts, simulation algorithms and original snapshots.
- Regression evidence: original snapshot checks and existing simulation tests, targeted route-update tests, browser interactions and screenshots.

## Open questions
- None blocking this approved local adaptation. Production order/API and device contracts are not established by this demo. A real map/data integration remains outside this demo change.
