import { mountDesignGuide } from './design-guide.mjs';

mountDesignGuide(document.getElementById('design-guide'));
document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault();
  document.getElementById('page-heading').focus();
});
