// Completion photo rules. The numbers are product choices, kept here so one edit changes them everywhere.
export const DEFAULT_PHOTOS = 1;
export const MAX_PHOTOS = 3;
/** The Meatbox rule on photo-less completions is still an open question (docs/integration-contract.md section 6). */
export const REQUIRE_COMPLETION_PHOTO = true;

/** Long side in pixels and JPEG quality: text on labels and the goods stay readable, a photo stays well under 1 MB. */
export const MAX_LONG_SIDE_PX = 1600;
export const JPEG_QUALITY = 0.8;
/** One retry at this quality when a photo is still above the server limit. */
export const RETRY_JPEG_QUALITY = 0.6;
/** The server rejects a larger upload with 413. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** Photos waiting on the device (all queued events) before a new completion warns about storage. */
export const MAX_QUEUED_PHOTOS = 150;

export type ResizePlan = { width: number } | { height: number } | null;

/** Shrinks the long side to [MAX_LONG_SIDE_PX], keeps the ratio, never enlarges. */
export function planResize(width: number, height: number): ResizePlan {
  if (!(width > 0) || !(height > 0)) return null;
  if (Math.max(width, height) <= MAX_LONG_SIDE_PX) return null;
  return width >= height ? { width: MAX_LONG_SIDE_PX } : { height: MAX_LONG_SIDE_PX };
}

export function canAddPhoto(count: number): boolean {
  return count < MAX_PHOTOS;
}

/** The sentence to show when a completion cannot be sent for lack of a photo, else null. */
export function missingPhotoMessage(kind: 'completed' | 'failed' | 'partial', count: number): string | null {
  return kind === 'completed' && REQUIRE_COMPLETION_PHOTO && count < DEFAULT_PHOTOS
    ? `완료 사진을 ${DEFAULT_PHOTOS}장 이상 첨부해 주세요.`
    : null;
}
