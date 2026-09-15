# Design

## Driver work-history calendar correction (2026-09-16, local)

- `근무 이력` opens a dedicated month calendar in the driver screen, with previous/next month, weekdays, selected date, today outline, and records below the calendar. Hide the delivery/map tab bar while this page is selected.
- Source-date dots indicate available source dispatch files, not attendance or completed work. Selected-day records use the existing driver/date lookup; absent work times remain unavailable. Driver identity comes only from the existing external viewer selector, including before dispatch publication. Never add an in-app driver switch or automatically substitute another driver when selection is missing.
- Month/day selection remains local to this page; the external driver selection is shared with the driver header and history query. Reuse the existing calendar month model and preserve the independent example-history dataset. Pending fetches are cached by date and identity; old responses cannot replace the current selection, and a failed lookup offers retry.

## Customer viewer scenario extension (2026-09-16, local)

- Source-backed customer viewers may rehearse all six stages before or after dispatch publication. These page-local previews never send an operational command or change source orders, assignments, or completion records. Historical operating dates remain read-only.
- Show one example vehicle near the selected store. Keep its random position stable across polling and store switching; `차량 위치 바꾸기` draws a new nearby position. Arrival places it at the store, and completion removes it. Missing coordinates remain unavailable.
- A preset updates the selected store's customer status, example clock, ETA window, timeline, and in-app notice together. Identify it as `고객 시연`; completion can be replayed without bypassing the driver photo-completion flow.
- `시연 초기화` restores the latest server-supplied delivery display, clears that store's preview notices, and draws a fresh example position. Date changes and page reloads discard previews. Original reference viewers and operational scenario commands retain their existing behavior.

## Source of truth
- Status: Vehicle-operations redesign deployed as 0187757 on 2026-09-15. Follow-up work is local until separately released. The 130-vehicle sample is not a fixed product contract.
- Last refreshed: 2026-09-16.
- Primary surfaces: combined operator, customer and driver viewers.
- Evidence: `../design.md`, `../previews/terminal-view/` approved reference and official assets, the current combined viewer, `/Users/jiin/Downloads/미트박스 TMS 역할 요약.docx`, and the user's fleet-operation corrections.
- This contract governs the combined demo. Owner snapshots remain unchanged.

## Brand
- Restrained operations UI, readable tables, clear selection. Use the original Meatbox logo and app icon from the official reference assets. Logo/navigation red is #E60028; brand ink is #212322; search/presentation accent remains #DB0E64.
- Controls use fixed-size SVG icons with centered hit areas. Use shared SVGs for route handles, movement arrows, completion checks and notification disclosure. Generated notification titles contain no decorative emoji; preserve manually authored copy and existing notice identity. Keep the approved map markers and compact attribution control.
- Avoid decorative dashboards, fabricated device data, and developer command names in normal workflows.

## Product goals
- Dispatch lifecycle correction (2026-09-16): current/future CSV driver links are candidate metadata, not confirmed assignments. Start with unassigned orders and available-driver selection, calculate a draft, review it, then confirm through 전체 배차 전송. Driver execution sees confirmed assignments only. Remove the former per-vehicle bulk-transfer meaning of 배차하기. Past dates are read-only in both UI and API against the configured operating date 2026-09-16. This latest decision supersedes earlier initial-source-assignment and immediate-reassignment wording below. Calculation policy and post-transmission pin-change publication remain pending user decisions.
- Latest identity decision (2026-09-16): equal destination name and address represent one destination with multiple child orders; route ordering assigns one sequence per destination bundle. This supersedes buyer/coordinate-based destination identity below. Detailed-address scope and cross-vehicle assignment rules are awaiting confirmation; do not rewrite assignments before they are resolved. Preserve order IDs, quantities and recorded facts.
- Customer/driver time displays may use explicit operating-plan estimates under the user's delegated decision: baseline06:30, first leg20min, coordinate distance factor1.3 at30km/h, handoff4min. Keep actual timestamps and supplied estimates higher priority. These estimates create no history, road geometry or GPS claims. Default transport guidance is 보냉 운송 / 포장 상태 확인; do not invent product contents or temperatures.
- Make operational jobs distinct while keeping one shared scenario, selected vehicle and separate destination detail across the received fleet.
- Let operators scan received orders on a map, compare many deliveries in a thin list, and monitor selected vehicles and inspect destination facts.
- Make presentation stages, time, changes and next action explainable in the guide.
- Non-goals: route-allocation algorithms, production integrations and external customer-message delivery. The provided CSV/SHP now supplies coordinates and existing boundaries for dispatch-only viewing and local manual reassignment.
- Success: operators can use the order map, data-sized delivery list, vehicle-first monitoring, customer notices and delivery tips without mistaking synthetic values or volume previews for live data.

## Personas and jobs
- Presenter: select a prepared order or delivery scene using a movable guide.
- Operator: find deliveries, edit remaining order, inspect events and monitor ETA.
- Customer reviewer: inspect the preserved mobile screen and its right-hand timeline.
- Driver reviewer: check the current destination and record completion after arrival.

## Information architecture
- Header: official brand → 운영 뷰어 / 고객 뷰어 / 배송원 뷰어. 인증 후 루트는 운영 뷰어로 바로 연결한다.
- Operator left menu: 배차 관리 / 배송 관제 / 자원 관리. Preserve legacy orders/deliveries/control route IDs. Viewer switching preserves selected delivery, filters and last operator page; customer/driver viewers do not select an operator item.
- 배차 관리: left vehicle list plus ALL coordinate-bearing order markers. Emphasize selected-vehicle orders with draw order and non-color cues, without hiding markers or changing coordinates. No vehicle markers on this map. Show location-unregistered counts.
- 주문 시나리오: received-box total 80–120% local preview, total vehicles/destinations/boxes and individual driver assignments. Use delivery-ID destination counts and boxes; do not infer unique households. Aggregate duration spans earliest fixed departure to latest handoff completion, with known vehicle coverage shown. Never mutate source quantities, assignment or ETA.
- Distinguish fixed scenario departure, last arrival ETA and final handoff-completion forecast. Use the existing simulation movement and unloading inputs for clearly labeled forecasts; missing inputs remain unknown.
- 권역: show verified boundaries from the provided SHP on the dispatch page. Verify CSV/SHP coordinate systems independently and preserve the source geometry. Connect only supplied region attributes; do not infer driver-exclusive boundaries. Manual group dispatch and single-order pin dispatch update local assignments only. Region editing and automatic allocation remain out of scope.
- 배송 관제: vehicle remaining workload comparison, explicit vehicle selection, map and a right vehicle card with expandable destinations. Keep current vehicle summary stable during historical stop inspection. Received order is the initial UI order, not a business priority; selectable sorts place unknown values last.
- Control map: selected vehicle remaining registered stops and supplied position with provenance. Simulation position is labeled and never used as actual GPS for support dispatch. Missing route geometry has no straight-line substitute.
- Right detail: expandable destinations show status, address, boxes, ETA, customer requests and driver tips. An 이력·알림 보기 action opens 배송 관리 for that destination without changing current vehicle operation context. Keep customer handoff requests, driver tips and product storage separate.
- 배송 관리 defaults to the selected destination and chronological records, with 전체 / 처리 이력 / 고객 알림 filters and notice composition. Keep the target visible above the bounded record list. Planned stages are not history; targetless events remain in a separate vehicle section.
- 지원배차: reasoned waiting entry point until stability levels, actual positions and call/accept/reassignment contracts exist. No invented score or successful instruction.
- 자원 관리: 배송원 / 차량 / 배송지 tabs. 배송지 is a cumulative destination directory through the selected operating date, independent of that day's route and vehicle assignment. Search names/addresses/regions, paginate alphabetically and show cumulative orders/boxes, order dates and registered tips. Do not show route sequence, live delivery status or ETA in this directory. Use the supplied buyer/address/detail/coordinate identity across dates without exposing member numbers or internal IDs. Missing cumulative data has its own empty/error state, never a daily-order substitute. Driver and vehicle tabs retain dated assignment/progress metrics and name/address/box lists linking to delivery management. Held deliveries remain in remaining workload. Unknown tendencies, evaluations, main areas and tips stay unregistered; profile candidates remain in docs/driver-profile-candidates.md.
- 배송 순서 관리 opens the existing route editor directly in edit mode within 배송 관리, without an additional edit-button step. Re-entry preserves any existing draft, preserving draft/save/cancel/protected-stop/stale-save behavior. Cancel discards unsaved edits and returns to records. Reset discards only unsaved edits while staying in the editor. Save stays in edit mode after acknowledgment and rebases the draft on the saved order. No separate back-to-records button. Synthetic resources never open live V1 execution commands.
- Customer and driver: shared header with viewer switching, no left operator menu. Use the full available page width while preserving the phone frame, right detail and responsive mobile body.
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
- Desktop header56px; at <=860px brand row44px + viewer row44px + border1px. Operator-only left rail92px/72px narrow. Content title begins24px below desktop header,20px narrow; no redundant operator eyebrow. Delivery metadata uses stacked rows, label64px + gap12px + flexible value, baseline aligned and padding12px 0.
- Operator cards use compact 14–20px headers and 40–44px actions. The vehicle workload summary groups remaining destinations, boxes and supplied duration; running facts use label/value rows. Keep current-stop facts distinct from the expanded historical destination. Do not force equal widths that wrap labels.
- Customer and driver phone maps zoom with the ordinary wheel without a modifier-key instruction screen. Driver route editing still locks map zoom.
- Dispatch source map exposes a `생략 보기 / 전체 핀 보기` switch, defaulting to 생략 보기. 생략 보기 preserves stable low-zoom thinning and shows every individual pin at zoom14. 전체 핀 보기 bypasses zoom/density hiding and its hit-test exclusions. Both modes preserve selected-vehicle foreground pins, other-vehicle50% opacity, original coordinates and current camera. Keep the chosen mode across date/vehicle updates within the mounted screen; never create number clusters.
- Dispatch and control reuse the DSV/OFM map, collapsed attribution and Command/Control-wheel guidance. Dispatch shows all registered orders; control shows selected-vehicle remaining stops with truthful position provenance.
- Delivery rows are 44px single lines on desktop. Arrival and completion share one outer border and one internal divider; responsive stacking must not double or break that border.
- Delivery tables give vehicle number and driver separate fixed-width columns of 140px and 90px; the address absorbs extra width. Page descriptions use natural sentences without decorative middle-dot separators. Preserve dots within geographic names such as 송파·강남.
- Design monitoring lists for at least 60 deliveries per vehicle: timeline/event rows are 32px, destination rows 40px and route-management rows 44px on desktop. Keep 44px touch actions in narrow layouts. Timeline, events, notifications, destinations and route management each scroll inside a bounded list; headers, tabs and actions stay outside that scroll area.
- Missing timeline times use the ASCII hyphen `-`, centered in the same 56px time column as known times. Notifications collapse to a single summary row and disclose the full body when opened. Route rows omit repeated address lines; their name control retains the address in its title and the delivery details provide the full address.

## Components
- Reuse existing ETA, timeline and event semantics while separating the customer time window from the precise operator ETA.
- An order-planning component owns the order markers and selected vehicle. Its corner popup owns only the browser-side 80–120% target-volume preview without changing source boxes, fleet, ETA or route state or generating vehicle positions.
- Customer notices and delivery tips are simulation records shared through the authenticated gateway. No screen claims external delivery.
- Monitoring starts with vehicle workload and a map; expandable destination details remain in the right vehicle card. Keep ETA facts and the timeline compact, preserve empty time columns explicitly, and retain 44px mobile action targets.
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
- On narrow monitoring screens, stack vehicle comparison, the selected-vehicle map and the right detail card. ETA responds to its card width: below 520px, stack the two fact groups to the right of the ETA; below 380px, move them below the ETA. Dividers follow group boundaries and labels remain on one line.
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
- Keep introductions short and natural; use 차량 1대, 배송지 8곳 without decorative separators. Do not insert a portal guide between login and the product. Keep the Sanghyun and Klein originals available only at their direct reference URLs.

## Implementation constraints
- Vanilla HTML/CSS/JS. The customer map uses the unchanged DSV `dsv-korea-v1` OpenFreeMap style and locally vendored MapLibre GL JS 5.24.0 CSP bundles and license from `clever-dsv-web`. Allow only its tile host and same-origin worker; OSRM routing is separate. Preserve actual coordinate and missing-coordinate behavior. The driver map uses the same local style and stored OSRM road legs. No npm dependency is added.
- Preserve both original workspace snapshots and the simulation algorithms. Remove automatic 500ms simulation progress, speed controls, and accident and dwell-delay controls from the combined flow without editing the preserved workspace sources. Current `OperatingSimulation` arrival and completion commands use single preset transitions; the bounded tick fallback remains only for generic original-simulation regression.
- Keep the current 130-vehicle and 4,523-destination fixture as temporary UI sample data, while deriving visible fleet, destination and box totals from each received snapshot. Customer ETA-window policy, notices and tips remain in the gateway wrapper and combined adapter.
- Keep `adapted.deliveries` as the current live V1 stops. Use `adapted.fleetDeliveries` and `adapted.fleetVehicles` for the received list sizes. Current fixture IDs may follow `V{2..130}-S{1..3}`, but those counts and identifiers are not future import requirements.
- `set_scenario` accepts only `received`, `picking`, `ready`, `shipping`, `arrived` and `completed` for live stop IDs `S1` through `S8`. Authentication, Origin validation, throttling, notice bounds, route CAS and the customer ETA policy remain in force.
- Legacy WebSocket progress commands `advance`, `place_order`, `speed`, `traffic` and `dwell` are rejected. Driver arrival and completion controls map to one `arrived` or `completed` scenario transition.
- `/scenario/` opens the preserved Sanghyun customer reference, and `/scenario/customer`, `/scenario/driver`, `/scenario/control`, `/scenario/present` serve their matching preserved HTML through the authenticated gateway. The gateway rewrites asset paths, normalizes the product title and hides retired traffic/dwell controls without editing frozen sources.
- Retain timers used for authentication cleanup, command-window cleanup and browser WebSocket reconnection. The scenario itself has no continuous timer.
- The current source of truth is [docs/vehicle-operations-redesign-plan.md](docs/vehicle-operations-redesign-plan.md), overriding conflicting older fleet decisions. This scope ends at local implementation and verification; deployment is a separate request.
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
- Match the native two-tab structure: 배송 and 지도. Keep the app header, settings/logout entries, 금일 배차/근무 이력 selector and native date calendar, route summary, start/final ETA, execution actions, numbered stop cards, order list, sequence editing, destination bottom sheet, completion proof sheet, settings and inquiry subviews. Scroll content inside the phone while its bottom tabs stay fixed.
- Map occupies 56 percent above the destination detail panel. Display numbered stop markers and the existing lime vehicle asset. Only stored OSRM geometry defines lines and the example vehicle coordinate; missing or malformed legs remain absent. The map theme and attribution behave like the customer map.
- Sequence editing uses a temporary order, protects current/completed/held destinations, supports pointer handles and keyboard moves, and saves with the existing expected-order/status/phase compare-and-set contract. Cancellation changes nothing. Live status changes invalidate a stale draft.
- Completion remains guarded by the current live vehicle reaching its stop. Completion and tip success require the returned server state, with pending/disconnected/error states. The completion button opens the evidence camera; a local photo is required before the customer-request confirmation button can send complete_stop. Closing, changing the current stop or losing the connection discards that proof. There is no proof upload or persistent work-history service. The calendar uses a separately labeled demo dataset, never the current completed stops.
- Native account, permission, inquiry and assignment services are absent. Keep their screen structure and truthful unavailable states; do not invent accounts, unassigned orders, inquiry records, remote sends or account deletion success. Product order counts are unavailable: show authoritative destination/box totals and item details rather than relabeling line items as orders.

## Vehicle operations open decisions (2026-09-15)
- Photo upload and persistent evidence storage remain unconnected; the local required-photo confirmation flow is decided.
- Support levels, actual positions, nearby criteria and external instructions have no contract.
- Destination IDs and boxes are the chosen units, and received order is the default. Aggregate duration and final handoff-completion forecasting still need data and definitions.
- Driver identity/metrics and customer request categories are unavailable. Calendar demo records are available; actual dated work-history integration is not.
- Existing brand, phone frame, clock, customer notifications, house/lime markers and half-size driver markers remain in force. No implementation/deployment claim follows from this document update.


## Confirmed workflow updates (2026-09-15, during implementation)
- Delivery completion opens the evidence camera. A photo is required, then the confirmation button sends the existing guarded completion command. No upload/persistent photo service exists: explicitly describe the local preview boundary. Cancel/rephoto never completes a stop; stale current-stop context blocks confirmation.
- Use destination ID count and boxes, not inferred unique households. Default order is received order; workload sorts are optional views.
- Support compares expected completion and actual completion pace when available. Show source facts and keep level thresholds undefined; do not invent rates or levels.
- Work history uses a separate clearly labeled dated demo dataset. Current completed stops are not historic records; actual persistent work-history integration remains absent.


## Local verification (2026-09-15)
- The confirmed local redesign is implemented and verified: 165 automated tests, 59 browser checks with no JavaScript errors, 22 modified/new JavaScript syntax checks, diff whitespace checks and the existing capacity/130-connection loopback checks passed.
- Requirement results and reproducible evidence are recorded in `docs/vehicle-operations-redesign-plan.md`, section 10. This does not certify real GPS, physical photo capture, persistent evidence/history, external instructions or deployment.
- Final handoff/duration forecasts, support level and command contracts, customer request data and driver metrics remain waiting states. Real region/pin dispatch functions remain intentionally unimplemented.


## Follow-up presentation changes (2026-09-15)
- Remove the red vehicle count from the dispatch list heading and the red registration counts from the map heading. Retain vehicle totals in existing page/scenario summaries and move location registration counts into a collapsed disclosure below the map. Selected vehicle names use normal ink with the existing selected-row surface.
- Remove the scenario reset-to-100 button; keep the range and numeric controls.
- The completion camera uses the user-supplied photograph when Photo or Retake is clicked. This is a demo capture action; do not add a separate example-photo button or badge. Retain required-photo and stale/disconnected-proof protections.

- Driver settings uses a centered eight-tooth circular gear, with the existing 22px icon / 40px button and 1.7px stroke. Avoid translated or vertically stretched gear outlines.

## Follow-up decisions in progress (2026-09-15)
- F1 current-assignment resource counts are approved to implement from existing data. They are not historical driver evaluations.
- F2: completion forecasts include the final unloading time using existing simulation inputs. Aggregate duration spans earliest fixed departure to latest completion; show incomplete vehicle coverage explicitly. F3: approved example customer requests have labeled icons and required per-request confirmation before final completion. F4: create unassigned profile candidates in documentation only; live tendencies/main areas remain unknown.

## Follow-up verification (2026-09-15)
- F1 current assignment metrics, F2 existing-input timing and known coverage, F3 example requests with mandatory confirmation, and F4 unassigned profile candidates are implemented and locally verified. See section 13 of docs/vehicle-operations-redesign-plan.md for evidence and external-data limitations.
- Driver compact requests show only category icons; control and metadata retain example provenance. Driver confirmation requires every required request ID plus a local photo; the gateway rechecks the current destination and exact request set. The reference driver completion button routes to the combined driver flow without editing owner snapshots.
- Final local evidence: 196 tests, JavaScript syntax, diff check, existing capacity/stream checks and native browser checks at desktop/390/320px. Follow-up changes are not deployed.

## Scenario remote destination navigation
- Add a ‘다음 배송지’ button beneath the selected destination. It selects the next entry in the current live V1 route in the initiating viewer; the existing six buttons then select that destination's scene.
- At the final destination, show disabled ‘마지막 배송지’. Disable navigation while disconnected, awaiting a scenario response, without a target or for synthetic vehicles. Preserve edited route order; do not increment destination IDs.
- Selection alone sends no scenario command and changes no delivery, notification, evidence or route draft. Other viewers retain their own delivery selection. No automatic playback or timer.

## Driver request symbols
- The current destination shows separate refrigerator, doorstep, indoor and handoff SVG symbols, with request labels as accessible names and tooltips. Remove the visible ‘예시 요청’ wording and generic request count from the driver viewer.
- Driver detail and photo-confirmation views retain readable request labels and required checkboxes under ‘고객 요청’, without the source badge. Control retains the source badge, and source metadata stays `example`.
- Use 44px centered icon buttons with 20px SVGs and the existing request colors. Clicking opens the existing driver sheet with only that request and the destination name; read-only display never marks the requirement fulfilled. S6 demonstrates indoor placement; keep S4's two required requests and S5's explicit empty state.

## Dated source data on dispatch (2026-09-16)
- The operating baseline is fixed at 2026-09-16. Map Wednesday 2025-09-17 source data to that day and shift all dates by the same 364 days, preserving weekdays and original sourceDate metadata internally. A small date catalog and one daily payload keep the year-sized source out of the browser.
- Preserve the left assignment list and full map. Source driver labels define provisional groups when vehicle identifiers are absent; state the missing vehicle/time data. Every valid order coordinate remains represented, including overlaps, and selected-group markers draw above the rest.
- Use the existing MapLibre WebGL sources/layers and DSV pin asset for dense points. At overview zooms, show a stable, spaced subset of individual pins; at zoom 14 and above show every individual order. No clusters, sampling, synthetic order coordinates or straight route substitutes. Supply keyboard-accessible order search/list alongside the map, and expose coincident orders individually on map click.
- Show the actual SHP boundaries with restrained fill and clear selected boundary. A boundary is not an editable dispatch assignment. Loading, unavailable dates, conversion failures and unmapped region codes have explicit states.
- Source imports now supply all combined viewers under the confirmed all-viewer scope below. Raw data and generated personal data stay in the ignored local data directory behind authentication. Legacy V1 simulation remains separate.
- Implementation scope and evidence: `docs/vehicle-operations-redesign-plan.md` section 17.

## Manual dispatch over original data (2026-09-16)
- Keep original driver labels and order quantities. Missing vehicle plates and capital-area locations use deterministic scenario values; preserve provenance internally while presenting the operating scenario without source/demo badges. These are not live GPS or actual fleet records. No vehicle pins are added to the dispatch map.
- Original driver groups provide candidate metadata only. Select available drivers, calculate a draft, and publish the entire draft through 전체 배차 전송. 핀배차 moves the selected destination and its same-name/address orders together among selected drivers. Drafts stay out of driver execution. Past dates are read-only. Missing calculation policy and post-publication assignment changes remain blocked until decided.
- Share date-scoped assignment overrides and local operational state in the server process. Original CSV, coordinates, quantities and legacy V1 commands remain unchanged. Cancellation does not assign. No external dispatch success, capacity check or ETA calculation is fabricated.
- Details and verification are recorded in plan sections 17–18 and docs/dated-dispatch-data.md.

## All viewers use actual source orders (2026-09-16)
- Dispatch, control, resources, driver and customer viewers share the selected operating date and real order/driver identities. Local progress/completion controls are explicitly approved; their events are current local actions, not imported historic timing.
- Use a representative readable real route as the default phone context. Preserve valid order selections and date in viewer links. Maps use real order coordinates without invented road routes.
- Source lacks product lines, customer requests, GPS and ETA inputs. Show unavailable values. Generated plates/vehicle positions retain internal provenance and cannot drive support rankings. No fake historical start/end times.
- Driver history shows original dated assignments for the same original driver. Local source operational state lasts for the server process and is not a persistent operation system. Plan section 19 defines implementation and verification.

## Operating calendar and wording (2026-09-16)
- Operating and dispatch date controls use the shared styled calendar popup instead of the browser date picker. Keep date and weekday together in the trigger (`2026.09.17 목`); remove the total-date-count/date-range line and standalone weekday. Show month navigation, selected day and unavailable dates; support keyboard navigation, Escape, outside dismissal and focus return. Month browsing alone never changes the operating day. Preserve previous/next available dispatch-day actions and date-linked state. The handset work-history calendar is outside this toolbar change.
- Latest user decision takes precedence over source badges: the product assumes operation on **2026.09.16** and uses “운영일”, “배차”, “배송 현황”, and “근무 이력”. Remove source/local/demo explanations from source-connected product views.
- Preserve the real input dates in generated metadata; shifted dates address day APIs, links, control and driver history consistently. The underlying order identities, quantities, assignments, coordinates and weekday patterns remain unchanged.
- Unknown GPS/ETA, product detail and customer requests remain unavailable. This presentation change does not connect external instructions, photo storage, or permanent history.
- Driver map numbers use an explicit 10px grid centered in the pin head, line-height 1 and tabular numerals. Keep the 22×26px half-size pin and exact coordinates.

## Dispatch map density by zoom (2026-09-16)
- Use fixed geographic cells to choose stable visible pins per zoom level. Panning and base-map labels must not change the chosen pins. Use fully opaque pins at each visibility level, with every pin visible at zoom 14. Do not vary opacity with fractional zoom. While a vehicle is selected, show other pins at 50% opacity and selected vehicle/order pins at 100%; restore full opacity when selection clears, without fade effects. Do not create count circles, clusters, or aggregate click actions. Retain every order and its exact position in the source.
- Selected vehicle/order pins use their existing slightly larger size and foreground order, with no white circle halos. All selected-vehicle pins bypass zoom visibility limits. Preserve exact coordinates, total counts and the complete order list. Keep existing Cmd/Control wheel guidance and real boundaries.


## Fixed regions and flexible subregion assignments (2026-09-16)
- The new SHP explicitly provides 72 parent regions (`PARENT_ID`) and 209 subregions (`SUB_ID`). Keep fixed boundary definitions separate from dated vehicle assignments. Region counts are not vehicle counts.
- Product direction: retain fixed regions and use their subregions as units to add to or remove from a vehicle's assigned area as workload changes. This does not authorize automatic boundary generation or deletion.
- The 75-box reference is a planning assumption, not a hard capacity. The user confirmed approximately 86 vehicles includes additional and reserve vehicles, distinct from the roughly 82 vehicles implied by box volume alone. Calculate dated workload from actual order quantities; the new SHP's BOX_MEAN matches row counts per day.
- This step documents the hierarchy and validates source geometry/order membership. Live UI and region assignment commands remain unchanged. See plan section 23 for evidence and remaining command rules.

- Clicking a different vehicle only selects it and preserves the camera. Clicking the already selected vehicle fits all its mapped deliveries; the same two-step interaction applies to all vehicles. No double-click timing requirement. Routine data refreshes preserve the camera. Keep max zoom15 and existing map padding.

## Compact dispatch vehicle list (2026-09-16)
- Source-backed vehicle rows use two lines: driver/plate, then region with order/box counts. Target a 52px row and 44px single-line section heading while retaining existing row text sizes. Keep complete values accessible and show full truncated labels in tooltips. Preserve sorting, scrolling, first-click selection and selected-vehicle-click zoom.
