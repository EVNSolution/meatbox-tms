export const noticeKey = notice => JSON.stringify([notice.id, notice.time, notice.title, notice.body]);

export function inboxState(notices, saved = {}, boot) {
  const keys = new Set(notices.map(noticeKey));
  const retained = field => saved.boot === boot && Array.isArray(saved[field])
    ? saved[field].filter(key => keys.has(key)) : [];
  return { boot, read: retained('read'), cleared: retained('cleared') };
}

export function visibleNotices(notices, state) {
  const cleared = new Set(state.cleared);
  return notices.filter(notice => !cleared.has(noticeKey(notice)));
}

export function updateInbox(notices, state, action, key) {
  const visible = visibleNotices(notices, state).map(noticeKey);
  if (action === 'clear') return { ...state, cleared: [...new Set([...state.cleared, ...visible])] };
  const read = action === 'read-all' ? visible : visible.includes(key) ? [key] : [];
  return { ...state, read: [...new Set([...state.read, ...read])] };
}
