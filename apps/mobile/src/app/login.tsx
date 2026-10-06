import { useEffect, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Body, Button, Card, Label } from "@/components/ui";
import { normalizeServerURL, storedServerURL } from "@/lib/session";
import { useSession } from "@/lib/session-context";
import { useTheme } from "@/lib/theme";

export default function Login() {
  const t = useTheme();
  const { signIn } = useSession();
  const [server, setServer] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void storedServerURL().then((s) => s && setServer(s));
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(normalizeServerURL(server), email.trim().toLowerCase(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const input = [s.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg }];
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
          <Text style={[s.brand, { color: t.text }]}>Hearloom</Text>
          <Body style={{ color: t.muted }}>Sign in to your own Hearloom server.</Body>
          <Card>
            <Label>Server</Label>
            <TextInput
              style={input}
              value={server}
              onChangeText={setServer}
              placeholder="http://your-mac.tailnet.ts.net:3000"
              placeholderTextColor={t.muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <Label>Email</Label>
            <TextInput
              style={input}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={t.muted}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
            />
            <Label>Password</Label>
            <TextInput
              style={input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="password"
              onSubmitEditing={submit}
            />
            {error ? <Text style={{ color: t.bad }}>{error}</Text> : null}
            <Button
              title="Sign in"
              onPress={submit}
              loading={busy}
              disabled={!server || !email || !password}
            />
          </Card>
          <Body style={{ color: t.muted, fontSize: 13 }}>
            Accounts are created by your server's admin (invite-only).
          </Body>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 20, gap: 16, paddingTop: 48 },
  brand: { fontSize: 34, fontWeight: "700" },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12, fontSize: 16 },
});
