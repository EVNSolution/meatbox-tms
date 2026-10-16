/**
 * Whether a completion may go on when the product check found a problem (an item not read, or a code that belongs to
 * none of the stop's items). Meatbox has not said (docs/integration-contract.md section 6); until it does the
 * driver is only warned.
 */
export const ALLOW_COMPLETION_ON_SCAN_MISMATCH = true;

/** The camera reads the same code many times a second; a repeat inside this window is the same reading. */
export const RAPID_REPEAT_MS = 1_500;

/** The server takes at most 200 codes of up to 128 characters without spaces. */
export const MAX_SCANNED_CODES = 200;
export const MAX_CODE_LENGTH = 128;
