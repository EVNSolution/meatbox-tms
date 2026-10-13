// Every vehicle today is generated from the day's driver-label group, not a real registry
// (services/api .../dispatch/DispatchFleet.kt and this package's dispatch-assignment.mjs; RFP
// item 18 / F07 introduces a real one). Keep the "is this verified" decision and its wording in
// one place so every screen stays consistent, and a future real source only needs to set
// vehicle.source = 'registered' to turn this off everywhere at once.
export function isUnverifiedVehicle(vehicle) {
  return vehicle?.source !== 'registered';
}

export function plateLabel(vehicle) {
  if (!vehicle?.plate) return '차량 미등록';
  return isUnverifiedVehicle(vehicle) ? `${vehicle.plate} (미검증)` : vehicle.plate;
}

// The generator already marks its own output with the word '예시' (example). Swap that one word
// for '미검증' (unverified) instead of deleting it: the position still reads as a plain place name
// (no engineering jargon reaches the operator), but the disclosure that it is not a real fix survives.
export function locationLabel(vehicle) {
  const label = String(vehicle?.location?.label ?? '').trim();
  if (!label) return '위치 미등록';
  return isUnverifiedVehicle(vehicle) ? label.replace(/예시/g, '미검증') : label;
}
