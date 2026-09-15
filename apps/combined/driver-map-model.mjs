const coordinate = pair => Array.isArray(pair) && pair.length === 2 && pair.every(Number.isFinite) && Math.abs(pair[0]) <= 90 && Math.abs(pair[1]) <= 180;

// Each feature remains one stored OSRM leg. Missing legs never get joined across a gap.
export function driverMapModel(data, deliveries, dwelling = false) {
  const stops = deliveries.filter(stop => stop.status !== 'skipped');
  const points = stops.flatMap(stop => {
    const point = data?.points?.find(point => point.id === stop.id);
    return point && coordinate([point.lat, point.lng]) ? [{ ...stop, coordinate: [point.lng, point.lat] }] : [];
  });
  let previous = 'MFC';
  let vehicle = null;
  const features = stops.flatMap(stop => {
    const leg = data?.legs?.[`${previous}>${stop.id}`]?.coords;
    previous = stop.id;
    if (!Array.isArray(leg) || leg.length < 3 || !leg.every(coordinate)) return [];
    const coordinates = leg.map(([lat, lng]) => [lng, lat]);
    if (stop.status === 'current') vehicle = coordinates[dwelling ? coordinates.length - 1 : Math.floor(coordinates.length * 0.4)];
    return [{ type: 'Feature', properties: { status: stop.status }, geometry: { type: 'LineString', coordinates } }];
  });
  return { points, vehicle, road: { type: 'FeatureCollection', features } };
}
