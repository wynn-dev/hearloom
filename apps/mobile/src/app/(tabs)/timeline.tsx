import type { Timeline as TimelineData } from "@hearloom/api";
import { useQuery } from "@tanstack/react-query";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Body, Pill } from "@/components/ui";
import { formatDuration } from "@/lib/capture";
import { useSignedIn } from "@/lib/session-context";
import { useTheme } from "@/lib/theme";

type Item =
  | { kind: "utterance"; at: Date; u: TimelineData["utterances"][number] }
  | { kind: "sound"; at: Date; s: TimelineData["soundEvents"][number] }
  | { kind: "bookmark"; at: Date; b: TimelineData["bookmarks"][number] }
  | { kind: "chunk"; at: Date; c: TimelineData["chunks"][number] }
  | { kind: "device"; at: Date; e: TimelineData["deviceEvents"][number] };

const DEVICE_LABEL: Record<string, string> = {
  wearable_connected: "Pendant connected",
  wearable_disconnected: "Pendant disconnected",
  muted: "Muted",
  unmuted: "Unmuted",
};

function dayRange(offset: number): { from: Date; to: Date; label: string } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() + offset);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  const label =
    offset === 0
      ? "Today"
      : offset === -1
        ? "Yesterday"
        : from.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  return { from, to, label };
}

const hhmm = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export default function Timeline() {
  const t = useTheme();
  const { orpc, session } = useSignedIn();
  const [offset, setOffset] = useState(0);
  const range = useMemo(() => dayRange(offset), [offset]);
  const q = useQuery({
    ...orpc.timeline.range.queryOptions({ input: { from: range.from, to: range.to } }),
    refetchInterval: offset === 0 ? 20_000 : false,
  });
  const player = useAudioPlayer(null);
  const playback = useAudioPlayerStatus(player);
  const [playing, setPlaying] = useState<string | null>(null);

  const sections = useMemo(() => {
    const d = q.data;
    if (!d) return [];
    const items: Item[] = [
      ...d.utterances.map((u) => ({ kind: "utterance" as const, at: u.startAt, u })),
      ...d.soundEvents.map((s) => ({ kind: "sound" as const, at: s.startAt, s })),
      ...d.bookmarks.map((b) => ({ kind: "bookmark" as const, at: b.at, b })),
      ...d.deviceEvents
        .filter((e) => e.kind in DEVICE_LABEL)
        .map((e) => ({ kind: "device" as const, at: e.at, e })),
      // Audio chunks only stand on their own when there's no transcript yet.
      ...(d.utterances.length === 0
        ? d.chunks.map((c) => ({ kind: "chunk" as const, at: c.startAt, c }))
        : []),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    const byHour = new Map<string, Item[]>();
    for (const it of items) {
      const h = new Date(it.at);
      h.setMinutes(0, 0, 0);
      const key = hhmm(h);
      byHour.set(key, [...(byHour.get(key) ?? []), it]);
    }
    return [...byHour].map(([title, data]) => ({ title, data }));
  }, [q.data]);

  const play = (id: string, url: string) => {
    if (playing === id && playback.playing) {
      player.pause();
      return;
    }
    player.replace({ uri: `${session.serverURL}${url}` });
    player.play();
    setPlaying(id);
  };

  const recorded = q.data?.chunks.reduce((n, c) => n + c.durationMs, 0) ?? 0;

  return (
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: t.bg }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          padding: 16,
        }}
      >
        <Pressable onPress={() => setOffset((o) => o - 1)} hitSlop={12}>
          <Text style={{ color: t.accent, fontSize: 22 }}>‹</Text>
        </Pressable>
        <View style={{ alignItems: "center" }}>
          <Text style={{ color: t.text, fontSize: 20, fontWeight: "700" }}>{range.label}</Text>
          <Text style={{ color: t.muted, fontSize: 13 }}>{formatDuration(recorded)} recorded</Text>
        </View>
        <Pressable
          onPress={() => setOffset((o) => Math.min(0, o + 1))}
          hitSlop={12}
          disabled={offset === 0}
        >
          <Text style={{ color: offset === 0 ? t.border : t.accent, fontSize: 22 }}>›</Text>
        </Pressable>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(it) =>
          `${it.kind}-${"u" in it ? it.u.id : "s" in it ? it.s.id : "b" in it ? it.b.id : "c" in it ? it.c.id : it.e.id}`
        }
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />
        }
        stickySectionHeadersEnabled
        renderSectionHeader={({ section }) => (
          <Text
            style={{ color: t.muted, backgroundColor: t.bg, paddingVertical: 6, fontWeight: "600" }}
          >
            {section.title}
          </Text>
        )}
        ListEmptyComponent={
          <Body style={{ color: t.muted, textAlign: "center", marginTop: 48 }}>
            {q.isLoading
              ? "Loading…"
              : q.isError
                ? "Couldn't load the timeline."
                : "Nothing recorded this day."}
          </Body>
        }
        renderItem={({ item }) => {
          const time = (
            <Text style={{ color: t.muted, fontSize: 12, width: 44 }}>{hhmm(item.at)}</Text>
          );
          switch (item.kind) {
            case "utterance": {
              const who =
                item.u.personName ?? (item.u.isWearer ? "Me" : (item.u.speakerKey ?? "Someone"));
              return (
                <View style={{ flexDirection: "row", gap: 8, paddingVertical: 6 }}>
                  {time}
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: t.accent, fontWeight: "600", fontSize: 13 }}>{who}</Text>
                    <Text style={{ color: t.text, fontSize: 15 }}>{item.u.text}</Text>
                  </View>
                </View>
              );
            }
            case "sound":
              return (
                <View
                  style={{ flexDirection: "row", gap: 8, paddingVertical: 4, alignItems: "center" }}
                >
                  {time}
                  <Pill text={item.s.label} />
                </View>
              );
            case "bookmark":
              return (
                <View style={{ flexDirection: "row", gap: 8, paddingVertical: 4 }}>
                  {time}
                  <Text style={{ color: t.warn, fontWeight: "600" }}>
                    ⚑ Bookmark{item.b.note ? ` — ${item.b.note}` : ""}
                  </Text>
                </View>
              );
            case "device":
              return (
                <View style={{ flexDirection: "row", gap: 8, paddingVertical: 2 }}>
                  {time}
                  <Text style={{ color: t.muted, fontSize: 13 }}>{DEVICE_LABEL[item.e.kind]}</Text>
                </View>
              );
            case "chunk": {
              const active = playing === item.c.id && playback.playing;
              return (
                <Pressable
                  onPress={() => play(item.c.id, item.c.url)}
                  style={{ flexDirection: "row", gap: 8, paddingVertical: 6, alignItems: "center" }}
                >
                  {time}
                  <Text style={{ color: t.accent, fontSize: 15 }}>{active ? "❚❚" : "▶"}</Text>
                  <Text style={{ color: t.text }}>Audio · {formatDuration(item.c.durationMs)}</Text>
                </Pressable>
              );
            }
          }
        }}
      />
    </SafeAreaView>
  );
}
