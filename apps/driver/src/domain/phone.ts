/** A `tel:` link for the operations desk number, or null when the setting is empty or not a phone number. */
export function telUrl(raw: string | undefined | null): string | null {
  const value = (raw ?? '').trim();
  if (!/^\+?[0-9][0-9\s-]{3,18}[0-9]$/u.test(value)) return null;
  return `tel:${value.replace(/[\s-]/gu, '')}`;
}
