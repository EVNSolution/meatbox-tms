import { deliveryLinks } from './delivery-review.mjs';

let lastId;
function syncOperatorLinks() {
  const id = new URLSearchParams(location.search).get('id');
  if (id === lastId) return;
  lastId = id;
  for (const link of document.querySelectorAll('[data-operator-link]')) link.href = deliveryLinks(id).operator;
}

// The original renderer updates this heading after both initial selection and store changes.
new MutationObserver(syncOperatorLinks).observe(document.getElementById('account-name'), { childList: true });
syncOperatorLinks();
