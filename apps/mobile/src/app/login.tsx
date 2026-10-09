import { parseLinkInput } from "@hearloom/shared";
import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Body, Button, Card, Label } from "@/components/ui";
import { normalizeServerURL, storedServerURL } from "@/lib/session";
import { useSession } from "@/lib/session-context";
import { useTheme } from "@/lib/theme";

type Form = "link" | "password";

export default function Login() {
  const t = useTheme();
  const { signIn, linkDevice } = useSession();
  const [server, setServer] = useState("");
  const [linkText, setLinkText] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Which form is working, and which one the error belongs to.
  const [busy, setBusy] = useState<Form | null>(null);
  const [error, setError] = useState<{ form: Form; message: string } | null>(null);

  useEffect(() => {
    void storedServerURL().then((s) => s && setServer(s));
  }, []);

  // A pasted link says which server it's for; a bare code needs the Server field.
  const link = parseLinkInput(linkText);
  const linkServer = link?.server ?? (server.trim() ? normalizeServerURL(server) : null);

  const run = async (form: Form, action: () => Promise<void>) => {
    setBusy(form);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError({ form, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const submitLink = () => {
    if (!link || !linkServer) return;
    void run("link", () => linkDevice(linkServer, link.code));
  };

  const submitPassword = () =>
    void run("password", () =>
      signIn(normalizeServerURL(server), email.trim().toLowerCase(), password),
    );

  const input = [s.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg }];
  const serverField = (
    <>
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
    </>
  );
  const errorText = (form: Form) =>
    error?.form === form ? <Text style={{ color: t.bad }}>{error.message}</Text> : null;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
          <Text style={[s.brand, { color: t.text }]}>Hearloom</Text>
          <Body style={{ color: t.muted }}>Link this iPhone to your own Hearloom server.</Body>
          <Card>
            <Body>
              In the Hearloom console on your Mac: Devices → Link a device, then scan the QR code
              with the iPhone Camera app — or paste the link or code here.
            </Body>
            <Label>Link or code</Label>
            <TextInput
              style={input}
              value={linkText}
              onChangeText={setLinkText}
              placeholder="XXXX-XXXX-XXXX"
              placeholderTextColor={t.muted}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={submitLink}
            />
            {linkText.trim() && !link ? (
              <Body style={{ color: t.muted, fontSize: 13 }}>
                Paste the whole link, or type the 12-character code.
              </Body>
            ) : null}
            {link?.server ? (
              <Body style={{ color: t.muted, fontSize: 13 }}>Connects to {link.server}</Body>
            ) : link ? (
              serverField
            ) : null}
            {errorText("link")}
            <Button
              title="Link this iPhone"
              onPress={submitLink}
              loading={busy === "link"}
              disabled={!link || !linkServer || busy === "password"}
            />
          </Card>
          <Pressable onPress={() => setUsePassword((v) => !v)} hitSlop={8}>
            <Text style={[s.toggle, { color: t.accent }]}>
              {usePassword ? "Hide password sign-in" : "Sign in with a password instead"}
            </Text>
          </Pressable>
          {usePassword ? (
            <Card>
              {serverField}
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
                onSubmitEditing={submitPassword}
              />
              {errorText("password")}
              <Button
                title="Sign in"
                onPress={submitPassword}
                loading={busy === "password"}
                disabled={!server || !email || !password || busy === "link"}
              />
            </Card>
          ) : null}
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
  toggle: { fontSize: 15, fontWeight: "500", textAlign: "center" },
});
