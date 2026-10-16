import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useRef, useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { isRapidRepeat, type ScanResult } from '../domain/scanMatch';
import { Button, T } from './common';
import { colors, radius } from './theme';

const BARCODE_TYPES = [
  'qr', 'ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'code93', 'itf14', 'codabar', 'datamatrix', 'pdf417',
] as const;

const FEEDBACK: Record<ScanResult['kind'], { text: string; ok: boolean }> = {
  matched: { text: '일치', ok: true },
  duplicate: { text: '이미 읽은 코드', ok: false },
  unregistered: { text: '이 배송지 품목에 없는 코드', ok: false },
  invalid: { text: '읽을 수 없는 코드', ok: false },
};

// Reads product labels one after another. Every reading goes to [onScan], which compares it with the stop's items
// and keeps the codes; the camera stays open so the driver can scan the whole load.
export function CodeScanner({
  readCount,
  total,
  onScan,
  onClose,
}: {
  readCount: number;
  total: number;
  onScan(raw: string): ScanResult;
  onClose(): void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [last, setLast] = useState<ScanResult | null>(null);
  const previous = useRef<{ code: string; at: number } | null>(null);

  function onBarcodeScanned(result: BarcodeScanningResult) {
    const now = Date.now();
    if (isRapidRepeat(previous.current, result.data, now)) return;
    previous.current = { code: result.data, at: now };
    setLast(onScan(result.data));
  }

  return (
    <Modal animationType="slide" onRequestClose={onClose} visible>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <T style={styles.title}>상품 코드 스캔 {readCount}/{total}</T>
          <Button label="닫기" onPress={onClose} tone="secondary" />
        </View>
        <View style={styles.stage}>
          {permission?.granted ? (
            <CameraView
              barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }}
              facing="back"
              onBarcodeScanned={onBarcodeScanned}
              style={StyleSheet.absoluteFill}
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.blocked]}>
              <T style={styles.blockedText}>카메라 권한이 없으면 코드를 직접 입력해 주세요.</T>
              {permission?.canAskAgain !== false ? <Button label="권한 허용" onPress={() => void requestPermission()} tone="action" /> : null}
            </View>
          )}
          {last ? (
            <View style={[styles.result, FEEDBACK[last.kind].ok ? styles.resultOk : styles.resultBad]}>
              <T style={styles.resultText}>
                {FEEDBACK[last.kind].text}
                {last.kind === 'matched' ? ` · ${last.items.map((item) => item.name).join(', ')}` : ''}
                {last.kind !== 'invalid' ? ` (${last.code})` : ''}
              </T>
            </View>
          ) : null}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  header: { alignItems: 'center', backgroundColor: colors.surface, flexDirection: 'row', justifyContent: 'space-between', padding: 12 },
  title: { fontSize: 17, fontWeight: '800' },
  stage: { backgroundColor: '#000', flex: 1 },
  blocked: { alignItems: 'center', gap: 12, justifyContent: 'center', padding: 24 },
  blockedText: { color: colors.surface, fontSize: 15, textAlign: 'center' },
  result: { borderRadius: radius.card, bottom: 24, left: 12, padding: 12, position: 'absolute', right: 12 },
  resultOk: { backgroundColor: colors.green },
  resultBad: { backgroundColor: colors.error },
  resultText: { color: colors.surface, fontSize: 15, fontWeight: '700' },
});
