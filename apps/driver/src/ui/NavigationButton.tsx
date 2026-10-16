import { useState } from 'react';
import { Modal, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NAV_APPS, type NavApp, type NavTarget } from '../domain/navigation';
import { openNavigation, openWebNavigation, planNavigation } from '../platform/navigation';
import { Button, T } from './common';
import { colors, radius } from './theme';

// "길안내": opens the installed navigation app at this stop. One installed app opens directly, several are asked once
// (and remembered if the driver says so; a long press asks again), none opens Google Maps on the web.
export function NavigationButton({ target }: { target: NavTarget }) {
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState<NavApp[] | null>(null);
  const [remember, setRemember] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function start(forceAsk: boolean) {
    setBusy(true); setNote(null);
    try {
      const { choice } = await planNavigation(target, forceAsk);
      if (choice.kind === 'ask') { setChoosing(choice.apps); return; }
      const link = choice.kind === 'use' ? await openNavigation(choice.app, target, false) : await openWebNavigation(target);
      if (!link.guided) setNote('좌표가 없어 주소로 검색합니다. 길안내는 지도 앱에서 시작해 주세요.');
    } catch {
      setNote('내비게이션 앱을 열지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  async function pick(app: NavApp) {
    setChoosing(null); setBusy(true); setNote(null);
    try {
      const link = await openNavigation(app, target, remember);
      if (!link.guided) setNote('좌표가 없어 주소로 검색합니다. 길안내는 지도 앱에서 시작해 주세요.');
    } catch {
      setNote('내비게이션 앱을 열지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <Button
        accessibilityHint="길게 누르면 길안내 앱을 다시 고릅니다."
        busy={busy}
        label="길안내"
        onLongPress={() => void start(true)}
        onPress={() => void start(false)}
        tone="action"
      />
      {note ? <T style={styles.note}>{note}</T> : null}
      {choosing ? (
        <Modal animationType="fade" onRequestClose={() => setChoosing(null)} transparent visible>
          <SafeAreaView style={styles.scrim}>
            <View style={styles.sheet}>
              <T style={styles.title}>길안내 앱 선택</T>
              {choosing.map((id) => (
                <Button key={id} label={NAV_APPS.find((app) => app.id === id)?.label ?? id} onPress={() => void pick(id)} tone="secondary" />
              ))}
              <View style={styles.remember}>
                <T style={styles.rememberText}>다음부터 이 앱으로 바로 열기</T>
                <Switch onValueChange={setRemember} value={remember} />
              </View>
              <Button label="취소" onPress={() => setChoosing(null)} tone="secondary" />
            </View>
          </SafeAreaView>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  note: { color: colors.amber, fontSize: 13 },
  scrim: { backgroundColor: colors.scrim, flex: 1, justifyContent: 'flex-end', padding: 12 },
  sheet: { backgroundColor: colors.surface, borderRadius: radius.card, gap: 8, padding: 14 },
  title: { fontSize: 17, fontWeight: '800' },
  remember: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  rememberText: { flex: 1, fontSize: 15 },
});
