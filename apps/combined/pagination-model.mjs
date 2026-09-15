export const PAGE_SIZE = 50;

export function paginate(items, requestedPage, pageSize = PAGE_SIZE) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), pageCount);
  const offset = (page - 1) * pageSize;
  return {
    items: items.slice(offset, offset + pageSize),
    page,
    pageCount,
    start: items.length ? offset + 1 : 0,
    end: Math.min(offset + pageSize, items.length),
    total: items.length,
  };
}
