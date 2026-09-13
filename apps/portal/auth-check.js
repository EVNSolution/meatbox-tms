(() => {
  async function check() {
    try {
      const response = await fetch('/api/session', { cache: 'no-store' });
      if (response.status === 401) location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash));
    } catch { /* The simulation connection reports network outages. */ }
  }
  check();
  window.addEventListener('pageshow', check);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  setInterval(check, 30_000);
  const home = document.createElement('a');
  home.href = '/'; home.textContent = '작업 선택';
  const brand = document.querySelector('.app-header .brand, .logo');
  if (brand) {
    home.className = brand.className;
    home.innerHTML = brand.innerHTML;
    home.setAttribute('aria-label', '작업 선택으로');
    home.style.textDecoration = 'none';
    brand.replaceWith(home);
    return;
  }
  home.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;padding:8px 14px;border:1px solid #ccd3de;border-radius:3px;background:#fff;color:#263345;font:600 12px Arial,sans-serif;box-shadow:0 2px 8px #26334515;text-decoration:none';
  document.body.append(home);
})();
