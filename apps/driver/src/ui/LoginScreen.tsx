import { useState } from 'react';
import { KeyboardAvoidingView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { login } from '../api/client';
import { ApiError, type SessionUser } from '../api/types';
import { Button, Logo, T } from './common';
import { colors, fontFamily, radius, TOUCH_MIN } from './theme';

export function LoginScreen({ onLogin }: { onLogin(user: SessionUser): void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      onLogin(await login(username.trim(), password));
    } catch (cause) {
      setError(loginErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView behavior="height" style={styles.body}>
        <View style={styles.brand}>
          <Logo height={34} />
          <T style={styles.title}>배송원 앱</T>
          <T style={styles.caption}>TMS 계정으로 로그인합니다.</T>
        </View>
        <View style={styles.form}>
          <T style={styles.label}>아이디</T>
          <TextInput
            autoCapitalize="none"
            autoComplete="username"
            autoCorrect={false}
            onChangeText={setUsername}
            placeholder="아이디"
            placeholderTextColor={colors.muted}
            style={styles.input}
            value={username}
          />
          <T style={styles.label}>비밀번호</T>
          <TextInput
            autoComplete="password"
            onChangeText={setPassword}
            onSubmitEditing={() => void submit()}
            placeholder="비밀번호"
            placeholderTextColor={colors.muted}
            secureTextEntry
            style={styles.input}
            value={password}
          />
          {error ? <T accessibilityRole="alert" style={styles.error}>{error}</T> : null}
          <Button
            busy={busy}
            disabled={username.trim() === '' || password === ''}
            label="로그인"
            onPress={() => void submit()}
            style={styles.submit}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function loginErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401) return '아이디 또는 비밀번호를 확인해 주세요.';
    if (cause.status === 429) return '로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요.';
    if (cause.status === 403) return '접속 출처가 허용되지 않았습니다.';
    return `로그인할 수 없습니다. (${cause.status})`;
  }
  return '서버에 연결할 수 없습니다. 네트워크를 확인해 주세요.';
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  body: { flex: 1, justifyContent: 'center', padding: 24 },
  brand: { alignItems: 'center', gap: 8, marginBottom: 32 },
  title: { fontSize: 22, fontWeight: '800' },
  caption: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  form: { gap: 8 },
  label: { color: colors.muted, fontSize: 14, fontWeight: '600', marginTop: 8 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.control,
    borderWidth: 1,
    color: colors.text,
    fontFamily,
    fontSize: 16,
    minHeight: TOUCH_MIN + 4,
    paddingHorizontal: 12,
  },
  error: { color: colors.error, fontSize: 14, marginTop: 8 },
  submit: { marginTop: 16 },
});
