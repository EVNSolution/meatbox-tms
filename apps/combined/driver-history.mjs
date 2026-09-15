const exampleHistory = [
  {
    date: '2026-09-12',
    id: 'EXAMPLE-20260912-1',
    label: '예시 오전 배차',
    vehicle: '예시 차량 101',
    startedAt: '06:30',
    endedAt: '11:20',
    destinations: 18,
    boxes: 36,
  },
  {
    date: '2026-09-14',
    id: 'EXAMPLE-20260914-1',
    label: '예시 오전 배차',
    vehicle: '예시 차량 101',
    startedAt: '06:40',
    endedAt: '12:05',
    destinations: 21,
    boxes: 43,
  },
  {
    date: '2026-09-14',
    id: 'EXAMPLE-20260914-2',
    label: '예시 오후 지원 배차',
    vehicle: '예시 차량 203',
    startedAt: '13:10',
    endedAt: '15:00',
    destinations: 6,
    boxes: 11,
  },
];

export const exampleHistoryDates = [...new Set(exampleHistory.map(item => item.date))];

export function driverHistoryForDate(date) {
  return exampleHistory.filter(item => item.date === date).map(item => ({ ...item }));
}
