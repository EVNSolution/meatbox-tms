# Design

## Source of truth
- Status: Active. User approved the 130-vehicle fleet expansion, local verification and deployment on 2026-09-14.
- Last refreshed: 2026-09-14.
- Primary surfaces: combined operator, customer and driver viewers.
- Evidence: `../design.md`, `../previews/terminal-view/` approved reference and official assets, the current combined viewer, `/Users/jiin/Downloads/미트박스 TMS 역할 요약.docx`, and the user's fleet-operation corrections.
- This contract governs the combined demo. Owner snapshots remain unchanged.

## Brand
- Restrained operations UI, readable tables, clear selection. Use the original Meatbox logo and app icon from the official reference assets. Logo/navigation red is #E60028; brand ink is #212322; search/presentation accent remains #DB0E64.
- Avoid decorative dashboards, fabricated device data, and developer command names in normal workflows.

## Product goals
- Make operational jobs distinct while keeping one shared scenario and selected delivery across a 130-vehicle example fleet.
- Let operators scan received orders on a map, compare many deliveries in a thin list, and monitor one selected delivery without duplicated detail.
- Make presentation stages, time, changes and next action explainable in the guide.
- Non-goals: real order coordinates, region boundaries, route-allocation algorithms, production integrations and external customer-message delivery.
- Success: operators can use the order map, 395-row delivery list, selected-delivery monitoring, customer notices and delivery tips without mistaking synthetic values for live data.

## Personas and jobs
- Presenter: progress and explain the scenario using a movable guide.
- Operator: find deliveries, edit remaining order, inspect events and monitor ETA.
- Customer reviewer: inspect the preserved mobile screen and its right-hand timeline.
- Driver reviewer: check the current destination and record completion after arrival.

## Information architecture
- Header: official brand → 운영 뷰어 / 고객 뷰어 / 배송원 뷰어 → 시연 안내.
- Operator left menu: 주문 관리 / 배송 목록 / 배송 관제. Viewer switching preserves selected delivery, filters and last operator page; customer/driver viewers do not select an operator item.
- 목록: 130 vehicles and 395 destinations in 44px single-line rows, with vehicle/status/search filters and a separate selected-delivery summary.
- 주문 관리: a wide order-allocation map for already-received orders, plus a 0–7,800 box planning editor. Show only explicitly labeled example position markers until real coordinates arrive; do not invent region boundaries, paths or allocation results.
- 관리: full route, explicit edit mode, row handles, save/cancel in the 배송 관제 right-side 배송 관리 tab; preserve pending/current/completed/held and stale-save safeguards.
- 관제: one selected delivery's precise ETA, customer window, arrival, completion, timeline, events and customer notices. Remove the device panel and control-page map. The right side contains the selected vehicle's thin destination list and live V1 route management.
- Monitoring never repeats the selected destination as a second detail card. Explicit links retain their selected delivery; live progress never changes an explicit selection. Synthetic selections stay synthetic and never open V1 route or completion actions.
- Customer: shared three-axis header/rail, preserve desktop phone viewer and right timeline and responsive mobile body.
- Driver: same authenticated simulation, current destination and ordered stops; reuse existing completion behavior, available only after actual simulated arrival. Keep current/selected delivery distinct.
- Legacy #/manage routes redirect to #/control with the management tab selected.
- Legacy control route opens monitoring; legacy customer summary goes to the customer viewer.
- Customer viewers show a ±30 minute window around the promised ETA. Operator viewers keep the precise ETA. A new delay notice is created only when the precise ETA becomes strictly more than 30 minutes later than the current customer promise baseline.
- Driver viewers follow the selected vehicle context and can edit a delivery tip of up to 500 characters. Synthetic vehicle tips use that vehicle's demo driver as author and never enable V1 completion actions. Operator notices accept up to 300 characters and create internal demo records only.

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
- The order map is the only map in the combined operator viewer. Example markers are UI positions rather than geographic claims.
- Delivery rows are 44px single lines on desktop. Arrival and completion share one outer border and one internal divider; responsive stacking must not double or break that border.

## Components
- Reuse existing ETA, timeline and event semantics while separating the customer time window from the precise operator ETA.
- An order-planning component owns the map markers, selected vehicle and box quantity without resetting user input on live updates.
- Customer notices and delivery tips are simulation records shared through the authenticated gateway. No screen claims external delivery.
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
- On narrow monitoring screens, stack selected delivery details, timeline, events and the selected-vehicle list. ETA cells use equal padding and one divider between the two rows.
- At 320px and 390px, the order map and planning controls stack without horizontal overflow, and delivery rows keep at least 44px action height.

## Interaction states
- Existing connection notices cover loading and offline state.
- Empty filter results do not hide unrelated management/monitoring deliveries.
- Pending saves disable resubmission. Stale route edits require fresh data, never silent overwrite.
- Customer and driver form typing survives unrelated live state updates. Save success appears only after the returned snapshot contains the requested value.
- Customer viewers treat the initial notice set as history and open a popup only for a new notice ID targeting the current delivery. A new server boot establishes a fresh initial history without replaying popups.
- Errors remain visible with a recovery action. No actual notification delivery is implied.

## Content voice
- Use concise Korean task labels and specific status/time text.
- Distinguish precise operator ETA, customer promise window, actual arrival and completion. The `±15 minutes at 80%` document target is an accuracy KPI, not the customer window or notice threshold.
- Keep introductions short and natural; prefer 차량 1대 · 배송지 8곳 over 차량 1대의 배송 8곳. Original links are 상현 시나리오 원본 and 클라인 UI 원본.

## Implementation constraints
- Vanilla HTML/CSS/JS; no new dependency.
- Preserve both original workspace snapshots and the simulation algorithms. Remove the accident and dwell-delay controls from the combined UI without deleting the underlying original functions.
- Add the 130-vehicle and 395-destination example data, customer ETA-window policy, notices and tips in the gateway wrapper and combined adapter.
- Keep `adapted.deliveries` as the eight live V1 stops. Use `adapted.fleetDeliveries` for all 395 rows and `adapted.fleetVehicles` for all 130 vehicles. Synthetic IDs follow `V{2..130}-S{1..3}`.
- Approved rollout and acceptance criteria are defined in [docs/fleet-operations-plan.md](docs/fleet-operations-plan.md) and [docs/fleet-operations-test-spec.md](docs/fleet-operations-test-spec.md). Use the existing authenticated release process and preserve production accounts.
- Regression evidence: exact data-count and threshold tests, original snapshot checks, authentication and route-CAS tests, responsive browser interactions and deployment postchecks.

## Open questions
- Production coordinate, region-boundary, allocation-algorithm, device and external-notification contracts are not established by this demo. The example markers and capacity calculation must be replaced when those inputs arrive.
