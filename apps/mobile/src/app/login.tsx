import { parseLinkInput } from "@hearloom/shared";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Body, Button, Card, Label } from "@/components/ui";
import { normalizeServerURL, storedServerURL } from "@/lib/session";
import { useSession } from "@/lib/session-context";
import { useTheme } from "@/lib/theme";

export default function Login() {
  const t = useTheme();
  const { linkDevice } = useSession();
  const [server, setServer] = useState("");
  const [linkText, setLinkText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void storedServerURL().then((s) => s && setServer(s));
  }, []);

  // A pasted link says which server it's for; a bare code needs the Server field.
  const link = parseLinkInput(linkText);
  const linkServer = link?.server ?? (server.trim() ? normalizeServerURL(server) : null);

  const submitLink = async () => {
    if (!link || !linkServer) return;
    setBusy(true);
    setError(null);
    try {
      await linkDevice(linkServer, link.code);
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
              onSubmitEditing={() => void submitLink()}
            />
            {linkText.trim() && !link ? (
              <Body style={{ color: t.muted, fontSize: 13 }}>
                Paste the whole link, or type the 12-character code.
              </Body>
            ) : null}
            {link?.server ? (
              <Body style={{ color: t.muted, fontSize: 13 }}>Connects to {link.server}</Body>
            ) : link ? (
              <>
                <Label>Server</Label>
                <TextInput
                  style={input}
                  value={server}
                  onChangeText={setServer}
                  placeholder="https://your-mac.your-tailnet.ts.net"
                  placeholderTextColor={t.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
              </>
            ) : null}
            {error ? <Text style={{ color: t.bad }}>{error}</Text> : null}
            <Button
              title="Link this iPhone"
              onPress={() => void submitLink()}
              loading={busy}
              disabled={!link || !linkServer}
            />
          </Card>
          <Body style={{ color: t.muted, fontSize: 13 }}>
            Accounts are created by your server's admin (invite-only). Lost every device? On the
            Mac, run pnpm link-device --email you@… for a new code.
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
