import { Image, Pressable, StyleSheet, View } from 'react-native';

import { canAddPhoto, MAX_PHOTOS } from '../domain/photoPolicy';
import type { PhotoSource } from '../platform/photoFiles';
import { Button, T } from './common';
import { colors, radius } from './theme';

// The photos of one report: thumbnails with a remove button, and the camera and album buttons.
export function PhotoStrip({
  uris,
  busy,
  onAdd,
  onRemove,
  error,
}: {
  uris: string[];
  busy: boolean;
  onAdd(source: PhotoSource): void;
  onRemove(index: number): void;
  error: string | null;
}) {
  const full = !canAddPhoto(uris.length);
  return (
    <View style={styles.wrap}>
      <T style={styles.title}>사진 {uris.length}/{MAX_PHOTOS}</T>
      {uris.length > 0 ? (
        <View style={styles.row}>
          {uris.map((uri, index) => (
            <View key={uri} style={styles.thumb}>
              <Image accessibilityLabel={`첨부 사진 ${index + 1}`} source={{ uri }} style={styles.image} />
              <Pressable
                accessibilityLabel={`사진 ${index + 1} 삭제`}
                accessibilityRole="button"
                disabled={busy}
                onPress={() => onRemove(index)}
                style={styles.remove}
              >
                <T style={styles.removeText}>×</T>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.row}>
        <Button busy={busy} disabled={full} label="촬영" onPress={() => onAdd('camera')} style={styles.add} tone="secondary" />
        <Button busy={busy} disabled={full} label="앨범" onPress={() => onAdd('library')} style={styles.add} tone="secondary" />
      </View>
      {full ? <T style={styles.hint}>사진은 {MAX_PHOTOS}장까지 첨부할 수 있습니다.</T> : null}
      {error ? <T accessibilityRole="alert" style={styles.error}>{error}</T> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  title: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 8 },
  thumb: { height: 84, width: 84 },
  image: { backgroundColor: colors.border, borderRadius: radius.card, height: 84, width: 84 },
  remove: {
    alignItems: 'center', backgroundColor: colors.overlay, borderRadius: 12, height: 24, justifyContent: 'center',
    position: 'absolute', right: 2, top: 2, width: 24,
  },
  removeText: { color: colors.surface, fontSize: 16, fontWeight: '800', lineHeight: 18 },
  add: { flex: 1 },
  hint: { color: colors.muted, fontSize: 12 },
  error: { color: colors.error, fontSize: 13 },
});
