import { mountDesignGuide } from './design-guide.mjs?v=20260929-mobile';

const byId = id => document.getElementById(id);

function normalizeHash() {
  if (location.hash !== '#/design') history.replaceState(null, '', '#/design');
}

window.addEventListener('hashchange', () => {
  normalizeHash();
  byId('page-heading').focus({ preventScroll: true });
  window.scrollTo(0, 0);
});

document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault();
  byId('page-heading').focus();
});

mountDesignGuide(byId('page-design'));
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--header-height', `${document.querySelector('.app-header').offsetHeight}px`);
}).observe(document.querySelector('.app-header'));
normalizeHash();
