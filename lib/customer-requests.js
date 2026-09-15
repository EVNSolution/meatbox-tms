'use strict';

// Explicitly approved demo requests. No requests are inferred from products or driver tips.
const labels = {
  doorstep: '문 앞에 두기',
  refrigerator: '매장 냉장고 안에 보관',
  indoor: '매장 안에 두기',
  handoff: '매장 담당자에게 직접 전달',
};
const examples = {
  S1: ['refrigerator'], S2: ['doorstep'], S3: ['handoff'],
  S4: ['refrigerator', 'handoff'], S5: [], S6: ['indoor'],
  S7: ['doorstep'], S8: ['refrigerator'],
};

function exampleRequestsFor(stopId) {
  if (!Object.hasOwn(examples, stopId)) return null;
  return { source: 'example', items: examples[stopId].map(kind => ({
    id: `${stopId}-${kind}`, kind, label: labels[kind], required: true,
  })) };
}

function validRequestConfirmation(stopId, confirmedIds = []) {
  const requests = exampleRequestsFor(stopId);
  if (!requests || !Array.isArray(confirmedIds) || new Set(confirmedIds).size !== confirmedIds.length) return false;
  const expected = requests.items.filter(item => item.required).map(item => item.id);
  return confirmedIds.length === expected.length && expected.every(id => confirmedIds.includes(id));
}

module.exports = { exampleRequestsFor, validRequestConfirmation };
