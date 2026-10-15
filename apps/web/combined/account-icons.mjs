// Sidebar account actions use the official Lucide icon set (https://lucide.dev), tree-shaken to three icons.
import { LogOut, Maximize, Settings, UserRound } from 'lucide';

const attributes = attrs => Object.entries(attrs).map(([name, value]) => `${name}="${value}"`).join(' ');

function svg(nodes) {
  const body = nodes.map(([tag, attrs]) => `<${tag} ${attributes(attrs)}/>`).join('');
  return `<svg class="app-icon" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

export const settingsIcon = svg(Settings);
export const accountIcon = svg(UserRound);
export const logoutIcon = svg(LogOut);
export const fitIcon = svg(Maximize);
