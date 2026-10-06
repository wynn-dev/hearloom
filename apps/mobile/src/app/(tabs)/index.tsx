import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { OmiCapture } from "omi-capture";
import { ScrollView, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Body, Button, Card, Label, Pill, Row, styles, Title } from "@/components/ui";
import { BLE_LABEL, formatDuration, timeAgo, useCaptureStatus } from "@/lib/capture";
import { useSignedIn } from "@/lib/session-context";
import { useTheme } from "@/lib/theme";

const ACTION_LABEL: Record<string, string> = {
  none: "Nothing",
  bookmark: "Bookmark",
  mute: "Mute / unmute",
  ack_nudge: "Acknowledge nudge",
};

export default function Pendant() {
  const t = useTheme();
  const router = useRouter();
  const { orpc, rpc } = useSignedIn();
  const status = useCaptureStatus();
  const live = useQuery({ ...orpc.status.live.queryOptions(), refetchInterval: 15_000 });
  const bookmark = useMutation({ mutationFn: () => rpc.bookmarks.create({}) });

  const listening = status.ble === "ready" && status.captureEnabled && !status.muted;
  const tone = status.muted
    ? "warn"
    : listening
      ? "good"
      : status.ble === "connecting"
        ? "warn"
        : "neutral";
  const backlogSec = (status.backlogFrames * 20) / 1000;

  return (
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={styles.screen}>
        <Text style={{ fontSize: 30, fontWeight: "700", color: t.text }}>Pendant</Text>

        <Card>
          <View
            style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
          >
            <Title>{status.wearable?.name ?? "Omi"}</Title>
            <Pill text={status.muted ? "Muted" : BLE_LABEL[status.ble]} tone={tone} />
          </View>
          {status.paired ? (
            <>
              <Row
                label="Recording"
                right={
                  <Switch
                    value={status.captureEnabled}
                    onValueChange={(v) => OmiCapture.setCaptureEnabled(v)}
                  />
                }
              />
              <Row
                label="Mute"
                right={
                  <Switch value={status.muted} onValueChange={(v) => OmiCapture.setMuted(v)} />
                }
              />
              {status.wearable?.battery !== undefined ? (
                <Row
                  label="Battery"
                  value={`${status.wearable.battery}%${status.charging ? " · charging" : ""}`}
                />
              ) : null}
              {status.wearable?.firmware ? (
                <Row label="Firmware" value={status.wearable.firmware} />
              ) : null}
              {status.codec !== undefined && status.codec !== 21 ? (
                <Row label="Codec" value={String(status.codec)} />
              ) : null}
            </>
          ) : (
            <>
              <Body style={{ color: t.muted }}>
                Pair your Omi to start recording. Remove it from the official Omi app first — the
                pendant accepts one phone at a time.
              </Body>
              <Button title="Pair pendant" onPress={() => router.push("/pair")} />
            </>
          )}
        </Card>

        <Card>
          <Label>Upload</Label>
          <Row
            label="Server"
            value={
              status.uplink === "open"
                ? "Connected"
                : status.uplink === "waiting"
                  ? "Retrying…"
                  : status.uplink
            }
          />
          <Row
            label="Waiting to upload"
            value={backlogSec < 1 ? "Nothing" : formatDuration(backlogSec * 1000)}
          />
          {status.lastAckAt ? <Row label="Last saved" value={timeAgo(status.lastAckAt)} /> : null}
          {status.serverError ? <Text style={{ color: t.bad }}>{status.serverError}</Text> : null}
          {status.uplinkError && status.uplink !== "open" ? (
            <Text style={{ color: t.muted }}>{status.uplinkError}</Text>
          ) : null}
        </Card>

        <Card>
          <Label>Pendant button</Label>
          <Row label="Tap" value={ACTION_LABEL[status.button.tap] ?? status.button.tap} />
          <Row
            label="Double tap"
            value={ACTION_LABEL[status.button.doubleTap] ?? status.button.doubleTap}
          />
          <Row label="Hold" value={ACTION_LABEL[status.button.hold] ?? status.button.hold} />
          <Button
            title={bookmark.isSuccess ? "Bookmarked" : "Bookmark this moment"}
            kind="secondary"
            loading={bookmark.isPending}
            onPress={() => bookmark.mutate()}
          />
        </Card>

        {live.data ? (
          <Card>
            <Label>Server view</Label>
            {live.data.streams.slice(0, 3).map((s) => (
              <Row
                key={s.id}
                label={s.wearableName ?? "Stream"}
                value={
                  s.live
                    ? "live"
                    : s.lastFrameAt
                      ? `last audio ${timeAgo(s.lastFrameAt.getTime())}`
                      : "no audio"
                }
              />
            ))}
            {live.data.streams.length === 0 ? (
              <Body style={{ color: t.muted }}>No recordings yet.</Body>
            ) : null}
          </Card>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
