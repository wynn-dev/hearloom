import type { ButtonAction, SettingsPatch } from "@hearloom/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { OmiCapture } from "omi-capture";
import { Alert, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Card, Label, Row, styles } from "@/components/ui";
import { useCaptureStatus } from "@/lib/capture";
import { useSession, useSignedIn } from "@/lib/session-context";
import { useTheme } from "@/lib/theme";

const ACTIONS: { value: ButtonAction; label: string }[] = [
  { value: "bookmark", label: "Bookmark" },
  { value: "mute", label: "Mute" },
  { value: "ack_nudge", label: "Ack nudge" },
  { value: "none", label: "None" },
];

function Segmented({
  value,
  onChange,
}: {
  value: ButtonAction;
  onChange: (v: ButtonAction) => void;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", backgroundColor: t.chip, borderRadius: 9, padding: 2 }}>
      {ACTIONS.map((a) => (
        <Pressable
          key={a.value}
          onPress={() => onChange(a.value)}
          style={{
            flex: 1,
            paddingVertical: 6,
            borderRadius: 7,
            alignItems: "center",
            backgroundColor: value === a.value ? t.card : "transparent",
          }}
        >
          <Text
            style={{ color: t.text, fontSize: 12, fontWeight: value === a.value ? "600" : "400" }}
          >
            {a.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export default function Settings() {
  const t = useTheme();
  const router = useRouter();
  const { signOut, refreshPush } = useSession();
  const { orpc, rpc, session, push } = useSignedIn();
  const qc = useQueryClient();
  const status = useCaptureStatus();
  const settings = useQuery(orpc.settings.get.queryOptions());
  const update = useMutation({
    mutationFn: (patch: SettingsPatch) => rpc.settings.update(patch),
    onSuccess: (data) => qc.setQueryData(orpc.settings.get.queryKey(), data),
  });
  const s = settings.data;

  return (
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={styles.screen}>
        <Text style={{ fontSize: 30, fontWeight: "700", color: t.text }}>Settings</Text>

        <Card>
          <Label>Account</Label>
          <Row label="Signed in as" value={session.email} />
          <Row label="Server" value={session.serverURL.replace(/^https?:\/\//, "")} />
          <Row
            label="Notifications"
            value={
              push === "granted"
                ? "On"
                : push === "pending"
                  ? "…"
                  : push === "denied"
                    ? "Off (Settings app)"
                    : "Not set up"
            }
          />
          {push !== "granted" && push !== "pending" ? (
            <Button
              title="Enable notifications"
              kind="secondary"
              onPress={() => void refreshPush()}
            />
          ) : null}
        </Card>

        {s ? (
          <Card>
            <Label>Pendant button</Label>
            <Text style={{ color: t.muted }}>Tap</Text>
            <Segmented
              value={s.button.tap}
              onChange={(v) => update.mutate({ button: { tap: v } })}
            />
            <Text style={{ color: t.muted }}>Double tap</Text>
            <Segmented
              value={s.button.doubleTap}
              onChange={(v) => update.mutate({ button: { doubleTap: v } })}
            />
            <Text style={{ color: t.muted }}>Hold</Text>
            <Segmented
              value={s.button.hold}
              onChange={(v) => update.mutate({ button: { hold: v } })}
            />
          </Card>
        ) : null}

        {s ? (
          <Card>
            <Label>Notifications</Label>
            <Row
              label={`Quiet hours ${s.quietHours.start}–${s.quietHours.end}`}
              right={
                <Switch
                  value={s.quietHours.enabled}
                  onValueChange={(v) => update.mutate({ quietHours: { enabled: v } })}
                />
              }
            />
            <Row
              label="Buzz pendant on nudges"
              right={
                <Switch
                  value={s.notifications.pendantHaptic}
                  onValueChange={(v) => update.mutate({ notifications: { pendantHaptic: v } })}
                />
              }
            />
            <Row label="Max nudges per hour" value={String(s.notifications.maxPerHour)} />
            <Row label="Timezone" value={s.timezone} />
            <Text style={{ color: t.muted, fontSize: 13 }}>More options in the web console.</Text>
          </Card>
        ) : null}

        <Card>
          <Label>Pendant</Label>
          <Button
            title="Test pendant vibration"
            kind="secondary"
            onPress={() => OmiCapture.testHaptic(2)}
          />
          {status.paired ? (
            <Button
              title="Forget pendant"
              kind="danger"
              onPress={() =>
                Alert.alert("Forget pendant?", "Recording stops until you pair again.", [
                  { text: "Cancel", style: "cancel" },
                  { text: "Forget", style: "destructive", onPress: () => OmiCapture.forget() },
                ])
              }
            />
          ) : (
            <Button title="Pair pendant" onPress={() => router.push("/pair")} />
          )}
          <Button title="Capture log" kind="secondary" onPress={() => router.push("/logs")} />
        </Card>

        <Button title="Sign out" kind="danger" onPress={() => void signOut()} />
      </ScrollView>
    </SafeAreaView>
  );
}
