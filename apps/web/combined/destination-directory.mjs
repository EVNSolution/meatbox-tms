import { referenceIcon } from './reference-icons.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const count = value => Number.isFinite(value) ? value.toLocaleString('ko-KR') : '—';
const dateText = value => value ? value.replaceAll('-', '.') : '—';

function destinationDetail(item) {
  if (!item) return '<p class="resource-empty">목록에서 배송지를 선택해 주세요.</p>';
  const fact = (label, value) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`;
  return `<div class="resource-detail-body">
    <p class="eyebrow">배송지 정보</p>
    <div class="resource-detail-heading"><h3>${escapeHtml(item.name)}</h3><span class="resource-detail-icon">${referenceIcon('location')}</span></div>
    <p class="destination-address">${escapeHtml(item.address)}</p>
    <dl class="resource-facts">
      ${fact('상세주소', item.detailAddress || '미등록')}
      ${fact('배송 권역', item.regionNames.join(', ') || '미등록')}
      ${fact('누적 주문', `${count(item.orderCount)}건`)}
      ${fact('누적 박스', `${count(item.boxCount)}박스`)}
      ${fact('최초 주문일', dateText(item.firstOrderDate))}
      ${fact('최근 주문일', dateText(item.lastOrderDate))}
      ${fact('주문이 있는 날', `${count(item.orderDays)}일`)}
    </dl>
    <section class="delivery-tip"><h4>배송팁</h4><p class="muted">등록된 배송팁이 없습니다.</p></section>
  </div>`;
}

export function mountDestinationDirectory({ element, fetchImpl = globalThis.fetch }) {
  element.innerHTML = `<section class="resource-panel destination-directory" aria-label="누적 배송지">
    <div class="resource-panel-heading"><div><h2>누적 배송지</h2><p data-destination-period>배송지 정보를 불러오고 있습니다.</p></div><span>가나다순</span></div>
    <dl class="destination-summary" data-destination-summary></dl>
    <label class="resource-search"><span class="sr-only">누적 배송지 검색</span>${referenceIcon('search')}<input type="search" data-destination-search placeholder="배송지명, 주소, 권역 검색" maxlength="100" autocomplete="off"></label>
    <div class="destination-message" data-destination-message role="status" aria-live="polite"></div>
    <div class="destination-split" data-destination-content hidden>
      <div class="destination-list-panel">
        <div class="destination-columns" aria-hidden="true"><span>배송지</span><span>누적 주문</span><span>누적 박스</span><span>최근 주문일</span></div>
        <ul class="destination-list" data-destination-list aria-label="누적 배송지 목록"></ul>
        <nav class="delivery-pagination" aria-label="누적 배송지 페이지"><p data-destination-range aria-live="polite"></p><div><button type="button" class="button subtle" data-destination-page="previous">이전</button><span data-destination-page-label></span><button type="button" class="button subtle" data-destination-page="next">다음</button></div></nav>
      </div>
      <aside class="destination-detail" data-destination-detail aria-label="선택 배송지 정보"></aside>
    </div>
  </section>`;
  const node = name => element.querySelector(`[data-destination-${name}]`);
  const search = node('search');
  const previous = element.querySelector('[data-destination-page="previous"]');
  const next = element.querySelector('[data-destination-page="next"]');
  let date;
  let page = 1;
  let query = '';
  let selectedId = null;
  let result = null;
  let pending = false;
  let requestId = 0;
  let controller;
  let timer;

  function renderSelection() {
    const selected = result.items.find(item => item.id === selectedId) || result.items[0];
    selectedId = selected?.id || null;
    node('list').innerHTML = result.items.map(item => `<li><button type="button" class="destination-row" data-destination-select="${escapeHtml(item.id)}" aria-pressed="${item.id === selectedId}">
      <span class="destination-copy"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><small title="${escapeHtml(item.address)}">${escapeHtml(item.address)}</small></span>
      <span class="destination-orders"><span class="destination-mobile-label">주문 </span>${count(item.orderCount)}건</span>
      <span class="destination-boxes"><span class="destination-mobile-label">박스 </span>${count(item.boxCount)}</span>
      <span class="destination-last-date"><span class="destination-mobile-label">최근 </span>${dateText(item.lastOrderDate)}</span>
    </button></li>`).join('');
    node('detail').innerHTML = destinationDetail(selected);
  }

  async function load() {
    clearTimeout(timer);
    const version = ++requestId;
    controller?.abort();
    result = null;
    pending = true;
    node('content').hidden = true;
    node('summary').innerHTML = '';
    node('message').textContent = date ? '누적 배송지를 불러오고 있습니다.' : '누적 배송지 자료가 연결되지 않았습니다.';
    node('period').textContent = date ? `${dateText(date)}까지의 주문 기준` : '누적 배송지';
    if (!date) { pending = false; return; }
    controller = new AbortController();
    const params = new URLSearchParams({ date, q: query, page: String(page), pageSize: '20' });
    try {
      const response = await fetchImpl(`/api/dispatch-data/destinations?${params}`, { signal: controller.signal, credentials: 'same-origin' });
      if (version !== requestId) return;
      if (!response.ok) {
        if (response.status === 404) {
          node('message').innerHTML = '<span>누적 배송지 자료가 연결되지 않았습니다.</span><button type="button" class="button subtle" data-destination-retry>다시 불러오기</button>';
          return;
        }
        throw new Error('load failed');
      }
      const data = await response.json();
      if (version !== requestId) return;
      if (data.date !== date || !Array.isArray(data.items) || !data.summary) throw new Error('invalid data');
      result = data;
      page = data.page;
      node('period').textContent = `${dateText(data.fromDate)} ~ ${dateText(date)} 주문 기준`;
      node('summary').innerHTML = `<div><dt>배송지</dt><dd>${count(data.summary.destinations)}곳</dd></div><div><dt>누적 주문</dt><dd>${count(data.summary.orders)}건</dd></div><div><dt>누적 박스</dt><dd>${count(data.summary.boxes)}박스</dd></div>`;
      node('message').textContent = data.total ? '' : query ? '검색한 배송지가 없습니다.' : '등록된 배송지가 없습니다.';
      node('content').hidden = data.total === 0;
      node('range').textContent = `${count((page - 1) * data.pageSize + 1)}–${count((page - 1) * data.pageSize + data.items.length)} / ${count(data.total)}곳`;
      node('page-label').textContent = `${count(page)} / ${count(data.pageCount)}`;
      previous.disabled = page <= 1;
      next.disabled = page >= data.pageCount;
      renderSelection();
    } catch (error) {
      if (version !== requestId || error.name === 'AbortError') return;
      result = null;
      node('message').innerHTML = '<span>누적 배송지를 불러오지 못했습니다.</span><button type="button" class="button subtle" data-destination-retry>다시 불러오기</button>';
    } finally {
      if (version === requestId) pending = false;
    }
  }

  function handleInput(event) {
    if (event.target !== search) return;
    query = search.value.trim();
    page = 1;
    selectedId = null;
    // Invalidate the old query immediately, including responses arriving during debounce.
    ++requestId;
    controller?.abort();
    clearTimeout(timer);
    pending = true;
    node('content').hidden = true;
    node('message').textContent = '검색 중입니다.';
    timer = setTimeout(load, 180);
  }

  function handleClick(event) {
    if (event.target.closest?.('[data-destination-retry]')) return load();
    if (pending || !result) return;
    const selection = event.target.closest?.('[data-destination-select]');
    if (selection) {
      selectedId = selection.dataset.destinationSelect;
      renderSelection();
      [...element.querySelectorAll('[data-destination-select]')].find(button => button.dataset.destinationSelect === selectedId)?.focus({ preventScroll: true });
      return;
    }
    const direction = event.target.closest?.('[data-destination-page]')?.dataset.destinationPage;
    if (!direction) return;
    page = Math.max(1, Math.min(result.pageCount, page + (direction === 'next' ? 1 : -1)));
    selectedId = null;
    return load().then(() => {
      if (result) (direction === 'next' && !next.disabled ? next : previous.disabled ? next : previous).focus({ preventScroll: true });
    });
  }

  element.addEventListener('input', handleInput);
  element.addEventListener('click', handleClick);
  return {
    update(nextDate) {
      if (date === (nextDate || null)) return;
      date = nextDate || null;
      page = 1;
      selectedId = null;
      return load();
    },
    destroy() {
      ++requestId;
      controller?.abort();
      clearTimeout(timer);
      element.removeEventListener('input', handleInput);
      element.removeEventListener('click', handleClick);
    },
  };
}
