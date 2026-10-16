import type { FleetDelivery } from './dispatch';
import { MAX_CODE_LENGTH, MAX_SCANNED_CODES, RAPID_REPEAT_MS } from './scanPolicy';

// The product check of a completion: codes read from labels (camera or typed) are compared with the barcodes that
// Meatbox sent with the stop's items. Presence only: whether `qty` counts units or kilograms, and whether a barcode
// names a SKU or a box, are open questions (docs/integration-contract.md section 6), so quantities are not compared.

export type ScanItem = { orderId: string; sku: string; name: string; key: string };

/** A code without spaces, as the server stores it. */
export function cleanCode(raw: string): string {
  return raw.replace(/\s+/gu, '');
}

/** What two codes are compared by: no hyphens, upper case. */
function compareKey(code: string): string {
  return cleanCode(code).replace(/-/gu, '').toUpperCase();
}

/** The items of the stop that have a barcode. Empty means the product check is skipped. */
export function expectedScanItems(orders: readonly FleetDelivery[]): ScanItem[] {
  return orders.flatMap((order) => (order.items ?? []).flatMap((item) => {
    const barcode = typeof item.barcode === 'string' ? compareKey(item.barcode) : '';
    const sku = typeof item.sku === 'string' ? item.sku : '';
    return barcode && sku ? [{ orderId: order.id, sku, name: item.name?.trim() || sku, key: barcode }] : [];
  }));
}

export type ScanResult =
  | { kind: 'invalid' }
  | { kind: 'duplicate'; code: string }
  | { kind: 'matched'; code: string; items: ScanItem[] }
  | { kind: 'unregistered'; code: string };

/** Compares one reading with the stop's items and the codes already taken. */
export function matchScan(raw: string, items: readonly ScanItem[], scanned: readonly string[]): ScanResult {
  const code = cleanCode(raw);
  if (!code || code.length > MAX_CODE_LENGTH) return { kind: 'invalid' };
  if (scanned.some((taken) => compareKey(taken) === compareKey(code))) return { kind: 'duplicate', code };
  if (scanned.length >= MAX_SCANNED_CODES) return { kind: 'invalid' };
  const key = compareKey(code);
  const hit = items.filter((item) => item.key === key);
  return hit.length > 0 ? { kind: 'matched', code, items: hit } : { kind: 'unregistered', code };
}

export type ScanSummary = {
  /** Every expected item with whether a code for it was read. */
  items: (ScanItem & { read: boolean })[];
  /** Items of the stop that no reading matched. */
  missing: ScanItem[];
  /** Codes read that belong to none of the stop's items. */
  unregistered: string[];
};

export function summarizeScans(items: readonly ScanItem[], scanned: readonly string[]): ScanSummary {
  const keys = new Set(scanned.map(compareKey));
  const marked = items.map((item) => ({ ...item, read: keys.has(item.key) }));
  const known = new Set(items.map((item) => item.key));
  return {
    items: marked,
    missing: marked.filter((item) => !item.read),
    unregistered: scanned.filter((code) => !known.has(compareKey(code))),
  };
}

/** True when the check found a problem the driver must be told about before completing. */
export function hasScanMismatch(summary: ScanSummary): boolean {
  return summary.missing.length > 0 || summary.unregistered.length > 0;
}

/** A reading that repeats the previous one within the camera's burst window is the same reading. */
export function isRapidRepeat(last: { code: string; at: number } | null, raw: string, now: number): boolean {
  return !!last && last.code === raw && now - last.at < RAPID_REPEAT_MS;
}
