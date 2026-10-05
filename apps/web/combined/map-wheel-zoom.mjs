export const modifierWheelZoomMessage = 'Control 또는 Command 키를 누른 상태에서 스크롤하여 지도를 확대하거나 축소하세요.';

export const modifierWheelZoomAllowed = event => Boolean(event?.ctrlKey || event?.metaKey);

// Reuse the blocker classes and animation bundled with the DSV MapLibre assets.
export function installModifierWheelZoom(map) {
  const container = map?.getContainer?.();
  const canvas = map?.getCanvasContainer?.();
  if (!container || !canvas || typeof document === 'undefined') return { setEnabled() {}, remove() {} };
  const screen = document.createElement('div');
  screen.className = 'maplibregl-cooperative-gesture-screen';
  screen.setAttribute('aria-hidden', 'true');
  const message = document.createElement('div');
  message.className = 'maplibregl-desktop-message';
  message.textContent = modifierWheelZoomMessage;
  screen.append(message);
  canvas.append(screen);
  let enabled = true;
  let timer;
  const onWheel = event => {
    if (!enabled || modifierWheelZoomAllowed(event)) return;
    event.stopPropagation();
    clearTimeout(timer);
    screen.classList.add('maplibregl-show');
    timer = setTimeout(() => screen.classList.remove('maplibregl-show'), 100);
  };
  const remove = () => {
    clearTimeout(timer);
    container.removeEventListener('wheel', onWheel, true);
    screen.remove();
  };
  container.addEventListener('wheel', onWheel, { capture: true, passive: true });
  map.once?.('remove', remove);
  return {
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) screen.classList.remove('maplibregl-show');
    },
    remove,
  };
}
