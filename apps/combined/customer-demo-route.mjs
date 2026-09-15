// The stored coordinates come from OSRM. Never synthesize an endpoint connector.
export function customerDemoRoad(routeData, stopId) {
  const coordinates = routeData?.legs?.[`MFC>${stopId}`]?.coords;
  if (!Array.isArray(coordinates) || coordinates.length < 3 || !coordinates.every(point =>
    Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
    && Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180)) return [];
  // A stable demo start on the road, independent of vehicles or GPS.
  return coordinates.slice(Math.floor(coordinates.length * .4)).map(([lat, lng]) => [lng, lat]);
}
