import { Directory, File, Paths } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { JPEG_QUALITY, MAX_PHOTO_BYTES, planResize, RETRY_JPEG_QUALITY } from '../domain/photoPolicy';

export type StoredPhoto = { localPath: string; bytes: number };
export type PhotoSource = 'camera' | 'library';

const OUTBOX_DIRECTORY = 'outbox';

/** One photo from the system camera or the photo picker, or null when the driver cancels or refuses permission. */
export async function pickPhoto(source: PhotoSource): Promise<ImagePicker.ImagePickerAsset | null> {
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return null;
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, allowsMultipleSelection: false };
  const result = source === 'camera'
    ? await ImagePicker.launchCameraAsync(options)
    : await ImagePicker.launchImageLibraryAsync(options);
  return result.canceled ? null : result.assets[0] ?? null;
}

async function render(uri: string, resize: ReturnType<typeof planResize>, compress: number) {
  return ImageManipulator.manipulateAsync(uri, resize ? [{ resize }] : [], {
    compress,
    format: ImageManipulator.SaveFormat.JPEG,
  });
}

/**
 * Shrinks and re-encodes a picked photo (policy in domain/photoPolicy.ts), then copies it into the app's document
 * folder, which the system does not clear, under the event that owns it. The temporary cache copy is deleted.
 */
export async function compressAndStore(
  asset: { uri: string; width: number; height: number },
  eventId: string,
  index: number,
): Promise<StoredPhoto> {
  const resize = planResize(asset.width, asset.height);
  let rendered = await render(asset.uri, resize, JPEG_QUALITY);
  let file = new File(rendered.uri);
  if ((file.size ?? 0) > MAX_PHOTO_BYTES) {
    file.delete();
    rendered = await render(asset.uri, resize, RETRY_JPEG_QUALITY);
    file = new File(rendered.uri);
  }
  const bytes = file.size ?? 0;
  if (bytes === 0 || bytes > MAX_PHOTO_BYTES) {
    file.delete();
    throw new Error('사진을 줄이지 못했습니다. 다시 촬영해 주세요.');
  }
  const folder = new Directory(Paths.document, OUTBOX_DIRECTORY, eventId);
  folder.create({ intermediates: true, idempotent: true });
  const stored = new File(folder, `${index}.jpg`);
  await file.copy(stored);
  file.delete();
  return { localPath: stored.uri, bytes };
}

/** Removes one stored photo; a missing file is not an error. */
export function deleteStoredPhoto(localPath: string): void {
  try {
    const file = new File(localPath);
    if (file.exists) file.delete();
  } catch {
    // Already gone or unreadable: nothing left to clean.
  }
}

/** Removes everything the event stored. */
export function deleteEventPhotos(eventId: string): void {
  try {
    const folder = new Directory(Paths.document, OUTBOX_DIRECTORY, eventId);
    if (folder.exists) folder.delete();
  } catch {
    // Best effort: a leftover folder only costs space.
  }
}

export function photoExists(localPath: string): boolean {
  try {
    return new File(localPath).exists;
  } catch {
    return false;
  }
}
