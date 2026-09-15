# Design

## Source of truth
- Status: Active. The current 130-vehicle sample was reviewed and deployed on 2026-09-14; its counts are not a fixed product contract.
- Last refreshed: 2026-09-14.
- Primary surfaces: combined operator, customer and driver viewers.
- Evidence: `../design.md`, `../previews/terminal-view/` approved reference and official assets, the current combined viewer, `/Users/jiin/Downloads/미트박스 TMS 역할 요약.docx`, and the user's fleet-operation corrections.
- This contract governs the combined demo. Owner snapshots remain unchanged.

## Brand
- Restrained operations UI, readable tables, clear selection. Use the original Meatbox logo and app icon from the official reference assets. Logo/navigation red is #E60028; brand ink is #212322; search/presentation accent remains #DB0E64.
- Controls use fixed-size SVG icons with centered hit areas. Use shared SVGs for route handles, movement arrows, completion checks and notification disclosure. Generated notification titles contain no decorative emoji; preserve manually authored copy and existing notice identity. Keep the approved map markers and compact attribution control.
- Avoid decorative dashboards, fabricated device data, and developer command names in normal workflows.

## Product goals
- Make operational jobs distinct while keeping one shared scenario and selected delivery across the fleet supplied by the current data.
- Let operators scan received orders on a map, compare many deliveries in a thin list, and monitor one selected delivery without duplicated detail.
- Make presentation stages, time, changes and next action explainable in the guide.
- Non-goals: real order coordinates, region boundaries, route-allocation algorithms, production integrations and external customer-message delivery.
- Success: operators can use the order map, data-sized delivery list, selected-delivery monitoring, customer notices and delivery tips without mistaking synthetic values or volume previews for live data.

## Personas and jobs
- Presenter: select a prepared order or delivery scene using a movable guide.
- Operator: find deliveries, edit remaining order, inspect events and monitor ETA.
- Customer reviewer: inspect the preserved mobile screen and its right-hand timeline.
- Driver reviewer: check the current destination and record completion after arrival.

## Information architecture
- Header: official brand → 운영 뷰어 / 고객 뷰어 / 배송원 뷰어. 인증 후 루트는 운영 뷰어로 바로 연결한다.
- Operator left menu: 주문 관리 / 배송 목록 / 배송 관제. Viewer switching preserves selected delivery, filters and last operator page; customer/driver viewers do not select an operator item.
- 목록: all destinations from the received data in 44px single-line rows, with vehicle/status/search filters and a separate selected-delivery summary. Clicking any non-action area of a delivery or route row selects that destination while the native name button keeps keyboard operation.
- 주문 관리: a wide order-allocation map for already-received orders. Keep quantity controls out of the body; a corner `지도 시나리오` popup previews a target volume from 80% to 120%, using the sum of received delivery boxes as the 100% baseline. Default and reset return to 100%. The preview does not redistribute boxes or mutate orders, vehicles, ETA, notices or route order. Show the original order marker box values. Treat a missing baseline as unknown and explicit empty data or zero as zero. Do not create vehicle-position markers or invent region boundaries, paths, allocation results or algorithm scores.
- 관리: full route, explicit edit mode, row handles, save/cancel in the 배송 관제 right-side 배송 관리 tab; preserve pending/current/completed/held and stale-save safeguards.
- 관제: one selected delivery's precise ETA, arrival, completion, timeline, events and customer notices. Omit the customer time window from the compact operator ETA card. Remove the device panel and control-page map. The right side contains the selected vehicle's thin destination list and live V1 route management.
- Monitoring never repeats the selected destination as a second detail card. Explicit links retain their selected delivery; live progress never changes an explicit selection. Synthetic selections stay synthetic and never open V1 route or completion actions.
- Customer: shared three-axis header/rail, preserve desktop phone viewer and right timeline and responsive mobile body.
- Driver: same authenticated simulation, selected live destination and ordered stops. Keep current/selected delivery distinct and disable scenario changes for synthetic vehicles.
- Legacy #/manage routes redirect to #/control with the management tab selected.
- Legacy control route opens monitoring; legacy customer summary goes to the customer viewer.
- Customer viewers show a ±30 minute window around the promised ETA. Operator viewers keep the precise ETA. A new delay notice is created only when the precise ETA becomes strictly more than 30 minutes later than the current customer promise baseline.
- Driver viewers follow the selected vehicle context and can edit a delivery tip of up to 500 characters. Synthetic vehicle tips use that vehicle's demo driver as author and never enable V1 completion actions. Operator notices accept up to 300 characters and create internal demo records only.

## Design principles
- Navigation reflects a job, not a rendering implementation or ownership branch.
- Put six direct scenario choices in the guide. `주문 관련` contains `접수 완료`, `피킹 중`, `출고 준비`; `배송 관련` contains `배송 중`, `배송지 도착`, `배송 완료`.
- Keep labels short. The guide selects a scene immediately and does not present a long step-by-step manual.
- Collapsed guide is a compact launcher; expanded guide stays movable.
- Route editing uses a local draft. Save once; cancel changes nothing. Protect current/completed stops and reject stale saves.

## Visual language
- Reuse `apps/combined/styles.css` tokens and the original UI's typography, panels, table density and left navigation.
- White surfaces, gray workspace, role-based radii 4/6/8/12px. Standard controls are 40px high (44px touch layouts). Pretendard Variable is self-hosted: body400, menus/states500, sections/buttons600, titles/times700.
- No left inset shadow, left pseudo strip or thick left border on any element. Selected rows use surface/text/badge state. Business tabs are full-rail-width 48px centered rectangles, radius0; active text and a straight right 3px rule use #E60028. Viewer tabs use an absolute bottom 3px rule that does not affect height.
- Desktop header56px; at <=860px brand row44px + viewer row44px + border1px. Left rail92px/72px narrow. Content title begins24px below desktop header,20px narrow; no redundant operator eyebrow. Delivery metadata uses stacked rows, label64px + gap12px + flexible value, baseline aligned and padding12px 0.
- Actual operator cards follow the approved guide with 20px headers, 18px/600 headings and 42px buttons. The compact ETA card is the sole exception: its header uses 8px vertical padding and a 14px/20px heading; thin dividers separate operating ETA, current sequence and status, and actual arrival and completion. All three groups use 8px vertical padding and equal height on desktop, without a customer time-window line or selected-destination summary card above them. Reserve at least 200px for the ETA and keep each fact label/value together with a 2px gap; do not force equal widths that wrap labels.
- The order map is the only map in the combined operator viewer. Red example order markers are UI positions rather than geographic claims; vehicles have no map marker until real coordinates arrive.
- Delivery rows are 44px single lines on desktop. Arrival and completion share one outer border and one internal divider; responsive stacking must not double or break that border.
- Delivery tables give vehicle number and driver separate fixed-width columns of 140px and 90px; the address absorbs extra width. Page descriptions use natural sentences without decorative middle-dot separators. Preserve dots within geographic names such as 송파·강남.
- Design monitoring lists for at least 60 deliveries per vehicle: timeline/event rows are 32px, destination rows 40px and route-management rows 44px on desktop. Keep 44px touch actions in narrow layouts. Timeline, events, notifications, destinations and route management each scroll inside a bounded list; headers, tabs and actions stay outside that scroll area.
- Missing timeline times use the ASCII hyphen `-`, centered in the same 56px time column as known times. Notifications collapse to a single summary row and disclose the full body when opened. Route rows omit repeated address lines; their name control retains the address in its title and the delivery details provide the full address.

## Components
- Reuse existing ETA, timeline and event semantics while separating the customer time window from the precise operator ETA.
- An order-planning component owns the order markers and selected vehicle. Its corner popup owns only the browser-side 80–120% target-volume preview without changing source boxes, fleet, ETA or route state or generating vehicle positions.
- Customer notices and delivery tips are simulation records shared through the authenticated gateway. No screen claims external delivery.
- Monitoring starts with the ETA card; destination selection remains in the right-side list and its current-destination button. Keep ETA facts and the timeline compact, preserve empty time columns explicitly, and retain 44px mobile action targets.
- Shared shell owns header viewer switching and the floating manual scenario selector. Scenario buttons target only live V1 stops `S1` through `S8`.
- A route editor owns temporary order, handle interactions and save/cancel; backend validates a full update before applying it.
- Route selection, draft moves and cancellation preserve the route-list scroll position. Drag edge scrolling moves the list itself, not the document. A 60-stop isolated UI fixture verifies the final row remains selectable and editable without altering the active local scenario.

## Accessibility
- Use links for page navigation, buttons for actions, labeled selects and real headings.
- Route handles support keyboard arrows, plus visible movement buttons in edit mode.
- Preserve focus during live updates. Distinguish saved, stale, disconnected and disabled states in text.
- Preserve reduced-motion styles and avoid communicating state by color alone.

## Responsive behavior
- Header wraps deliberately into two rows at <=860px; the operator rail stays vertical and narrows to72px. At <=520px viewer tabs divide the available row equally.
- Customer and driver viewers share `app-viewer.css`: 390×780 phone, 8px frame, 38px outer radius, 30px screen radius, speaker and internal scrolling. Both use the same title band, 32px workspace spacing and 420px side-panel limit. Below 1000px the panels stack; below 520px the frame is omitted in both views while the screen retains bounded scrolling. Customer interior follows the approved compact white composition. Driver interior follows the explicitly requested Clever Driver reference below.
- Guide and map-scenario popup stay within the viewport. Collapsed launcher occupies only a small footprint.
- On narrow monitoring screens, stack ETA, timeline, events and the selected-vehicle list. ETA responds to its card width: below 520px, stack the two fact groups to the right of the ETA; below 380px, move them below the ETA. Dividers follow group boundaries and labels remain on one line.
- At 320px and 390px, the order map and corner scenario popup stay within the viewport, and delivery rows keep at least 44px action height.

## Interaction states
- Existing connection notices cover loading and offline state.
- Empty filter results do not hide unrelated management/monitoring deliveries.
- Pending saves disable resubmission. Stale route edits require fresh data, never silent overwrite.
- Customer and driver form typing survives unrelated live state updates. Save success appears only after the returned snapshot contains the requested value.
- Every changed scenario selection creates a fresh notice ID for its target, including returning to a previously demonstrated state. Only an unchanged consecutive selection is a no-op. Customer viewers treat the initial notice set as history and open a popup only for a new notice ID targeting the current delivery. If several notices arrive together, the latest one drives the popup; every notice remains in the inbox. A new notice restarts the existing entrance transition even while the prior popup is still visible. A new server boot establishes a fresh initial history without replaying popups.
- Customer notice history retains at most the latest 50 entries per destination and 1,000 entries overall. Labels must describe this as retained recent history rather than a permanent archive.
- WebSocket command throttling is shared by username: ten commands per rolling second, with only the connection sending the eleventh command closed.
- Manual scenario buttons accept any of the six presets without waiting for an intermediate event. A changed selection performs one server calculation; repeating the same preset and stop is a no-op. Neither path starts a timer or animation loop.
- The top-level `scenarioPreset` and `scenarioStopId` fields identify the active choice. Both may be null after route or hold changes invalidate that meaning; reset establishes `received` and `S1`.
- Scenario changes preserve delivery tips and operator-authored manual notices. Synthetic selections show a clear read-only state.
- Scenario and route changes preserve existing customer promise windows and precise ETA baselines. Arrived and completed presets expose the selected stop's fixed actual arrival as the precise operator time, creating a first customer window only when none exists. Explicit reset is the only full ETA/promise reset.
- Errors remain visible with a recovery action. No actual notification delivery is implied.

## Content voice
- Use concise Korean task labels and specific status/time text.
- Operation history describes recorded outcomes such as order receipt, picking, departure, arrival and completion. Do not expose manual preset commands or simulation setup messages, or join destination and action with decorative middle dots. Keep the current in-memory history readable without resetting the scenario.
- Distinguish precise operator ETA, customer promise window, actual arrival and completion. The `±15 minutes at 80%` document target is an accuracy KPI, not the customer window or notice threshold.
- Keep introductions short and natural; prefer 차량 1대 · 배송지 8곳 over 차량 1대의 배송 8곳. Do not insert a portal guide between login and the product. Keep the Sanghyun and Klein originals available only at their direct reference URLs.

## Implementation constraints
- Vanilla HTML/CSS/JS. The customer map uses the unchanged DSV `dsv-korea-v1` OpenFreeMap style and locally vendored MapLibre GL JS 5.24.0 CSP bundles and license from `clever-dsv-web`. Allow only its tile host and same-origin worker; OSRM routing is separate. Preserve actual coordinate and missing-coordinate behavior. The driver map uses the same local style and stored OSRM road legs. No npm dependency is added.
- Preserve both original workspace snapshots and the simulation algorithms. Remove automatic 500ms simulation progress, speed controls, and accident and dwell-delay controls from the combined flow without editing the preserved workspace sources. Current `OperatingSimulation` arrival and completion commands use single preset transitions; the bounded tick fallback remains only for generic original-simulation regression.
- Keep the current 130-vehicle and 395-destination fixture as temporary UI sample data, while deriving visible fleet, destination and box totals from each received snapshot. Customer ETA-window policy, notices and tips remain in the gateway wrapper and combined adapter.
- Keep `adapted.deliveries` as the current live V1 stops. Use `adapted.fleetDeliveries` and `adapted.fleetVehicles` for the received list sizes. Current fixture IDs may follow `V{2..130}-S{1..3}`, but those counts and identifiers are not future import requirements.
- `set_scenario` accepts only `received`, `picking`, `ready`, `shipping`, `arrived` and `completed` for live stop IDs `S1` through `S8`. Authentication, Origin validation, throttling, notice bounds, route CAS and the customer ETA policy remain in force.
- Legacy WebSocket progress commands `advance`, `place_order`, `speed`, `traffic` and `dwell` are rejected. Driver arrival and completion controls map to one `arrived` or `completed` scenario transition.
- `/scenario/` opens the preserved Sanghyun customer reference, and `/scenario/customer`, `/scenario/driver`, `/scenario/control`, `/scenario/present` serve their matching preserved HTML through the authenticated gateway. The gateway rewrites asset paths, normalizes the product title and hides retired traffic/dwell controls without editing frozen sources.
- Retain timers used for authentication cleanup, command-window cleanup and browser WebSocket reconnection. The scenario itself has no continuous timer.
- Approved rollout and acceptance criteria are defined in [docs/fleet-operations-plan.md](docs/fleet-operations-plan.md) and [docs/fleet-operations-test-spec.md](docs/fleet-operations-test-spec.md). Use the existing authenticated release process and preserve production accounts.
- Regression evidence: fixture-integrity and 80%/100%/120% preview tests, original snapshot checks, authentication and route-CAS tests, responsive browser interactions and deployment postchecks.

## Open questions
- Production coordinate, region-boundary, allocation-algorithm, evaluation-metric, device and external-notification contracts are not established by this demo. The temporary fixture and volume preview must yield to the cleaned real-data contract when those inputs arrive.
- The demo does not require a real vehicle or GPS. Use a stable point partway through the stored OSRM road geometry as the example vehicle position, then draw only its remaining road coordinates to the selected store. Completed deliveries hide the vehicle and route. A new real address still requires a verified coordinate and a matching road-routing response; production geocoding and GPS integration remain pending.
- Draw a vehicle-to-store route only from a successful road-routing geometry response, including the stored OSRM demo data. Never connect the endpoints with a fabricated straight line. If coordinates or road geometry are unavailable, leave the route absent. Do not describe a computed road route or the example vehicle position as recorded driving or live GPS.

## Customer viewer refinement
- Keep the selected store name and store switcher outside the phone, above the delivery timeline in the right-side panel. Leave the right side of both viewer page headers empty. Both phones show the simulation time in the same fixed top status bar. The app reads as one signed-in store.
- Place the delivery status to the right of the arrival window, directly below the delivery heading. Present address and box quantity as labeled rows without decorative separators.
- A flat outline bell sits at the right edge of the Meatbox logo row. It opens an in-phone, scrollable notification history. Opening an entry marks it read; all-read and clear actions apply only to the selected store's viewer inbox. Persist those preferences in browser storage, scoped by store and server boot. Clearing retains operating records and permits later notices to arrive normally.
- New notices enter as an animated in-phone banner without interrupting focus. Clicking it opens that notice in the history. Initial history and store switches do not replay banners. Respect reduced-motion preferences.

## Customer presentation cleanup
- The customer store uses the DSV green house marker. Its vehicle uses the DSV truck artwork with a bright lime background (#BEF264). Neither customer marker displays a text caption; retain accessible names. Order-management destinations use the blue DSV pin, preserving their existing selection behavior and 44px hit area.
- Remove the thick red decoration from the top edge of the delivery ETA card. Preserve the existing shared phone-frame and notification shadows; the user clarified that the requested removal concerns the ETA card only.
- Omit the secondary logo tagline and decorative emoji from the customer store picker, map legend and product list. Use flat text labels for the two map positions; retain the functional outline notification bell and official Meatbox brand assets.
- Start the OpenFreeMap attribution collapsed as soon as its source details become available, without an expanded loading flash. Keep its native disclosure control and complete source links available when expanded.
- Approved customer composition: one white app surface, compact logo and bell row, prominent arrival window and status, map, then a concise order summary. Omit the repeated in-phone page title and visible map heading; retain accessible section labels. Replace nested cards with spacing and a single divider before the order summary. Show the box total in the summary heading. Preserve the shared phone frame, shadow, and external store selector.


## Driver viewer reference port
- User-approved source: `04_CLEVER_Route/clever-driver-app`, reference HEAD `bc1ad55b312061164bde75673bb401ef9e989592`. Read `DriverWorkspace`, `DeliveryScreen`, `DeliveryMapScreen`, `DeliverySpaceScreen`, `DestinationNotesSheet`, `DeliveryProofModal`, and `DriverSettingsModal`. Retain Meatbox names, logo, red palette, Pretendard, and the shared 390×780 phone shell.
- Match the native two-tab structure: 배송 and 지도. Keep the app header, settings/logout entries, active/completed route selector, route summary, start/final ETA, execution actions, numbered stop cards, order list, sequence editing, destination bottom sheet, completion proof sheet, settings and inquiry subviews. Scroll content inside the phone while its bottom tabs stay fixed.
- Map occupies 56 percent above the destination detail panel. Display numbered stop markers and the existing lime vehicle asset. Only stored OSRM geometry defines lines and the example vehicle coordinate; missing or malformed legs remain absent. The map theme and attribution behave like the customer map.
- Sequence editing uses a temporary order, protects current/completed/held destinations, supports pointer handles and keyboard moves, and saves with the existing expected-order/status/phase compare-and-set contract. Cancellation changes nothing. Live status changes invalidate a stale draft.
- Completion remains guarded by the current live vehicle reaching its stop. Completion and tip success require the returned server state, with pending/disconnected/error states. Photo selection is a local preview only; this gateway has no proof upload contract.
- Native account, permission, inquiry and assignment services are absent. Keep their screen structure and truthful unavailable states; do not invent accounts, unassigned orders, inquiry records, remote sends or account deletion success. Product order counts are unavailable: show authoritative destination/box totals and item details rather than relabeling line items as orders.
