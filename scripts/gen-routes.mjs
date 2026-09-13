// 정차지 쌍별 실제 도로 경로를 OSRM 공개 서버에서 한 번 받아와 route-data.js로 굽는다.
import { writeFileSync } from 'node:fs';

const points = [
  { id: 'MFC', name: '가락 MFC', lat: 37.4926, lng: 127.1116 },
  { id: 'S1', name: '문정갈비',       lat: 37.4850, lng: 127.1223 },
  { id: 'S2', name: '송파한우촌',     lat: 37.4779, lng: 127.1246 },
  { id: 'S3', name: '방이정육식당',   lat: 37.5117, lng: 127.1258 },
  { id: 'S4', name: '송리단길 숯불집', lat: 37.5075, lng: 127.1092 },
  { id: 'S5', name: '호수정육식당',   lat: 37.5083, lng: 127.0995 },
  { id: 'S6', name: '삼성한우명가',   lat: 37.5145, lng: 127.0585 },
  { id: 'S7', name: '역삼불백집',     lat: 37.5006, lng: 127.0364 },
  { id: 'S8', name: '논현숯불갈비',   lat: 37.5112, lng: 127.0214 },
];

const legs = {};
let calls = 0;
for (const a of points) {
  for (const b of points) {
    if (a.id === b.id) continue;
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const r = json.routes[0];
        legs[`${a.id}>${b.id}`] = {
          distance: Math.round(r.distance),          // m
          duration: Math.round(r.duration),          // s (OSRM 기준)
          coords: r.geometry.coordinates.map(([lng, lat]) => [
            Math.round(lat * 1e5) / 1e5,
            Math.round(lng * 1e5) / 1e5,
          ]),
        };
        ok = true;
      } catch (e) {
        console.error(`retry ${a.id}>${b.id}: ${e.message}`);
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    if (!ok) throw new Error(`failed: ${a.id}>${b.id}`);
    calls++;
    if (calls % 10 === 0) console.log(`${calls}/72`);
    await new Promise(r => setTimeout(r, 250)); // 공개 서버 예의상 간격
  }
}

const out = `// 자동 생성 파일 — scripts/gen-routes.mjs 참고 (OSRM ${new Date().toISOString().slice(0, 10)} 기준)
// legs['A>B'] = { distance(m), duration(s), coords: [[lat,lng], ...] }
module.exports = {
  points: ${JSON.stringify(points, null, 2)},
  legs: ${JSON.stringify(legs)},
};
`;
writeFileSync(process.argv[2] ?? 'route-data.js', out);
console.log(`done: ${Object.keys(legs).length} legs, ${(out.length / 1024).toFixed(0)} KB`);
