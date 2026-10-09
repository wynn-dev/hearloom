import { parseLinkInput } from "@hearloom/shared";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Body, Button, Card, Label } from "@/components/ui";
import type { Session } from "@/lib/session";
import { useSession } from "@/lib/session-context";
import { useTheme } from "@/lib/theme";

/** The server and code of hearloom://link?server=…&code=…, held to the same rules as a pasted link. */
function linkFromParams(server: unknown, code: unknown): { server: string; code: string } | null {
  if (typeof server !== "string" || typeof code !== "string") return null;
  const link = parseLinkInput(`hearloom://link?${new URLSearchParams({ server, code })}`);
  if (!link?.server || parseLinkInput(code)?.server !== null) return null;
  return { server: link.server, code };
}

function hostOf(serverURL: string): string {
  try {
    return new URL(serverURL).host;
  } catch {
    return serverURL;
  }
}

/** XXXX-XXXX-XXXX, however it came. */
function formatCode(code: string): string {
  return (
    code
      .toUpperCase()
      .replace(/[\s-]/g, "")
      .match(/.{1,4}/g)
      ?.join("-") ?? code
  );
}

/**
 * Where a scanned "Link device" QR code lands (the Camera app opens hearloom://link?…). Never links on
 * its own: someone else's QR code could otherwise point this phone, and everything the pendant hears,
 * at their server. So it shows where it would connect and waits for a tap.
 */
export default function LinkScreen() {
  const t = useTheme();
  const router = useRouter();
  const { state, linkDevice } = useSession();
  const params = useLocalSearchParams();
  const link = linkFromParams(params.server, params.code);
  const live = state.status === "signedIn" ? state.session : null;
  const [busy, setBusy] = useState(false);
  // Kept with the link it is about, so a newer link opened on top of this screen starts clean.
  const [failure, setFailure] = useState<{ link: string; message: string } | null>(null);
  const linkKey = link ? `${link.server} ${link.code}` : "";
  const error = failure?.link === linkKey ? failure.message : null;
  // Linking signs out (if signed in) and then in: keep showing the session it started from until done.
  const [startedFrom, setStartedFrom] = useState<Session | null | undefined>(undefined);
  const signedIn = startedFrom === undefined ? live : startedFrom;
  // Off to the app once the new session is in (the guards in _layout.tsx have switched by then).
  const [linked, setLinked] = useState(false);
  useEffect(() => {
    if (linked && live) router.replace("/");
  }, [linked, live, router]);

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace(live ? "/" : "/login");
  };

  const submit = async () => {
    if (!link) return;
    setBusy(true);
    setFailure(null);
    setStartedFrom(live);
    try {
      await linkDevice(link.server, link.code);
      setLinked(true);
    } catch (e) {
      setFailure({ link: linkKey, message: e instanceof Error ? e.message : String(e) });
      setBusy(false);
      setStartedFrom(undefined);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={s.wrap}>
        <Text style={[s.heading, { color: t.text }]}>Link this iPhone</Text>
        {!link ? (
          <>
            <Body style={{ color: t.muted }}>
              This link is incomplete or isn't from Hearloom. Make a new one in the Hearloom console
              on your Mac: Devices → Link a device.
            </Body>
            <Button
              title={live ? "Back to Hearloom" : "Go to sign in"}
              kind="secondary"
              onPress={leave}
            />
          </>
        ) : (
          <>
            <Card>
              <Label>Server</Label>
              <Text style={[s.host, { color: t.text }]}>{hostOf(link.server)}</Text>
              <Body style={{ color: t.muted, fontSize: 13 }}>{link.server}</Body>
              <Label>Code</Label>
              <Text style={[s.code, { color: t.text }]}>{formatCode(link.code)}</Text>
            </Card>
            {signedIn ? (
              <Body>
                This iPhone is already signed in{signedIn.email ? ` as ${signedIn.email}` : ""} on{" "}
                {hostOf(signedIn.serverURL)}. Linking signs it out there and sends what the pendant
                hears to {hostOf(link.server)} instead.
              </Body>
            ) : (
              <Body style={{ color: t.muted }}>
                Only link if you made this code in your own Hearloom console: this iPhone will send
                everything the pendant hears to this server.
              </Body>
            )}
            {error ? <Text style={{ color: t.bad }}>{error}</Text> : null}
            <Button
              title={signedIn ? "Sign out and link" : "Link this iPhone"}
              kind={signedIn ? "danger" : "primary"}
              onPress={submit}
              loading={busy}
            />
            <Button
              title={signedIn || !error ? "Cancel" : "Go to sign in"}
              kind="secondary"
              onPress={leave}
              disabled={busy}
            />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 20, gap: 16, paddingTop: 48 },
  heading: { fontSize: 28, fontWeight: "700" },
  host: { fontSize: 22, fontWeight: "600" },
  code: { fontSize: 20, fontWeight: "600", fontVariant: ["tabular-nums"], letterSpacing: 1 },
});
